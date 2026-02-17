import express from 'express';
import { cfg } from './config.js';
import { pool, q } from './db.js';
import { buildPassengerBot } from './bots/passenger.js';
import { buildDriverBot } from './bots/driver.js';
import { buildAdminBot } from './bots/admin.js';
import { buildAdminWeb } from './web/admin.js';
import { buildMiniWeb } from './web/mini.js';

// --- Helpers
async function listEligibleDrivers() {
  const r = await q(
    `SELECT u.id as user_id, u.tg_id, d.balance_azn
     FROM users u
     JOIN driver_profiles d ON d.user_id=u.id
     WHERE u.role='driver' AND d.status='approved' AND d.balance_azn > $1
     ORDER BY u.id DESC`,
    [cfg.pricing.driverBlockLimit]
  );
  return r.rows;
}

async function getPassengerTgIdByUserId(uid) {
  const r = await q('SELECT tg_id FROM users WHERE id=$1', [uid]);
  return r.rows[0]?.tg_id;
}

async function getDriverTgIdByUserId(uid) {
  const r = await q('SELECT tg_id FROM users WHERE id=$1', [uid]);
  return r.rows[0]?.tg_id;
}

// --- Bots
const driverBot = buildDriverBot();
const adminBot = buildAdminBot();

const passengerBot = buildPassengerBot({
  onNewRideRequest: async (req, ctx) => {
    const drivers = await listEligibleDrivers();
    if (!drivers.length) {
      await ctx.reply('Hazırda aktiv sürücü yoxdur. Bir az sonra yenidən yoxlayın.');
      return;
    }

    for (const d of drivers) {
      try {
        await driverBot.sendRideOffer(d.tg_id, req);
      } catch (e) {
        // ignore send errors
      }
    }
  },
});

// --- Driver actions

driverBot.action(/ride_reject:(\d+)/, async (ctx) => {
  try { await ctx.answerCbQuery('Rədd edildi'); } catch {}
  return ctx.editMessageReplyMarkup();
});

driverBot.action(/ride_accept:(\d+)/, async (ctx) => {
  const reqId = Number(ctx.match[1]);
  const driverTgId = ctx.from.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query('SELECT id FROM users WHERE tg_id=$1 LIMIT 1', [driverTgId]);
    const driverUserId = u.rows[0]?.id;
    if (!driverUserId) {
      await client.query('ROLLBACK');
      return ctx.answerCbQuery('Sürücü tapılmadı');
    }

    const prof = await client.query('SELECT status,balance_azn FROM driver_profiles WHERE user_id=$1', [driverUserId]);
    const p = prof.rows[0];
    if (!p || p.status !== 'approved') {
      await client.query('ROLLBACK');
      return ctx.answerCbQuery('Təsdiqlənməmisiniz');
    }
    if (Number(p.balance_azn) <= cfg.pricing.driverBlockLimit) {
      await client.query('ROLLBACK');
      return ctx.answerCbQuery('Balans limiti');
    }

    const rr = await client.query('SELECT * FROM ride_requests WHERE id=$1 FOR UPDATE', [reqId]);
    const req = rr.rows[0];
    if (!req || req.status !== 'searching') {
      await client.query('ROLLBACK');
      return ctx.answerCbQuery('Bu sifariş artıq götürülüb');
    }

    await client.query("UPDATE ride_requests SET status='matched', updated_at=NOW() WHERE id=$1", [reqId]);

    const rideIns = await client.query(
      `INSERT INTO rides(
        request_id, passenger_id, driver_id, status,
        pickup_lat,pickup_lng,pickup_text,
        dest_lat,dest_lng,dest_text,
        distance_km,fare_azn
      ) VALUES ($1,$2,$3,'accepted',$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        req.id,
        req.passenger_id,
        driverUserId,
        req.pickup_lat,
        req.pickup_lng,
        req.pickup_text,
        req.dest_lat,
        req.dest_lng,
        req.dest_text,
        req.distance_km,
        req.fare_azn,
      ]
    );

    await client.query('COMMIT');

    const ride = rideIns.rows[0];

    try { await ctx.editMessageReplyMarkup(); } catch {}
    try { await ctx.answerCbQuery('Qəbul edildi'); } catch {}

    // Notify passenger
    const passengerTg = await getPassengerTgIdByUserId(ride.passenger_id);
    if (passengerTg) {
      await passengerBot.telegram.sendMessage(
        passengerTg,
        `✅ Sürücü tapıldı!\nSifariş #${ride.request_id}\nGediş başladısa, sürücü sizə yaxınlaşacaq.`
      );
    }

    // Controls + Waze
    await driverBot.sendRideControls(driverTgId, ride);
    await driverBot.sendWaze(driverTgId, ride.pickup_lat, ride.pickup_lng);

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    try { await ctx.answerCbQuery('Xəta'); } catch {}
  } finally {
    client.release();
  }
});

driverBot.action(/ride_arrived:(\d+)/, async (ctx) => {
  const rideId = Number(ctx.match[1]);
  await q("UPDATE rides SET status='arrived', updated_at=NOW() WHERE id=$1", [rideId]);
  try { await ctx.answerCbQuery('Çatdı'); } catch {}
  return;
});

driverBot.action(/ride_start:(\d+)/, async (ctx) => {
  const rideId = Number(ctx.match[1]);
  await q("UPDATE rides SET status='started', started_at=NOW(), updated_at=NOW() WHERE id=$1", [rideId]);
  try { await ctx.answerCbQuery('Başladı'); } catch {}
  return;
});

driverBot.action(/ride_cancel:(\d+)/, async (ctx) => {
  const rideId = Number(ctx.match[1]);
  await q("UPDATE rides SET status='cancelled', updated_at=NOW() WHERE id=$1", [rideId]);
  try { await ctx.answerCbQuery('Ləğv edildi'); } catch {}
  return;
});

driverBot.action(/ride_finish:(\d+)/, async (ctx) => {
  const rideId = Number(ctx.match[1]);
  const driverTgId = ctx.from.id;

  const r = await q('SELECT * FROM rides WHERE id=$1', [rideId]);
  const ride = r.rows[0];
  if (!ride) return ctx.answerCbQuery('Tapılmadı');

  if (ride.status === 'completed') return ctx.answerCbQuery('Bitib');

  // Complete
  await q("UPDATE rides SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1", [rideId]);

  // Commission
  const { commission, nextBalance } = await driverBot.chargeCommission(ride.driver_id, ride.fare_azn);
  await q('UPDATE rides SET commission_azn=$2 WHERE id=$1', [rideId, commission]);

  // Big + bold price (Telegram MarkdownV2 safe)
  const amount = Number(ride.fare_azn || 0).toFixed(2);
  const text = `*MÜŞTƏRİDƏN ALINACAQ MƏBLƏĞ:*\n\n*${amount} AZN*`;

  await driverBot.telegram.sendMessage(driverTgId, text, { parse_mode: 'Markdown' });
  await driverBot.telegram.sendMessage(
    driverTgId,
    `Komissiya: -${commission.toFixed(2)} AZN (10%)\nYeni balans: ${Number(nextBalance).toFixed(2)} AZN`
  );

  if (Number(nextBalance) <= cfg.pricing.driverBlockLimit) {
    await driverBot.telegram.sendMessage(
      driverTgId,
      `⛔ Diqqət: Balans limitə düşdü (${cfg.pricing.driverBlockLimit} AZN).\nBalans artırana qədər sifariş ala bilməyəcəksiniz.`
    );
  }

  try { await ctx.answerCbQuery('Bitdi'); } catch {}
});

// --- Web server
const app = express();
app.get('/', (req, res) => res.send('PayTaksi service is running.'));
app.use(buildAdminWeb());
app.use(
  buildMiniWeb({
    passengerBot,
    driverBot,
    listEligibleDrivers,
  })
);

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(cfg.port, () => {
  console.log(`Web listening on :${cfg.port}`);
});

// --- Start bots (long polling)
async function startBots() {
  // Initialize DB (schema) if needed? Keep explicit script; but try minimal check.
  console.log('Starting bots...');
  await passengerBot.launch();
  await driverBot.launch();
  await adminBot.launch();

  console.log('✅ Bots started');
}

startBots().catch((e) => {
  console.error('Bot start failed', e);
  process.exit(1);
});

process.once('SIGINT', () => {
  passengerBot.stop('SIGINT');
  driverBot.stop('SIGINT');
  adminBot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  passengerBot.stop('SIGTERM');
  driverBot.stop('SIGTERM');
  adminBot.stop('SIGTERM');
});
