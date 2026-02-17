import { Telegraf, Markup } from 'telegraf';
import { q } from '../db.js';
import { passengerFlow, rideFlow } from '../state.js';
import { haversineKm, azPhoneNormalize } from '../utils.js';

async function ensurePassenger(tgUser) {
  const res = await q('SELECT * FROM passengers WHERE tg_user_id=$1', [tgUser.id]);
  return res.rowCount ? res.rows[0] : null;
}

async function createPassenger(tgUser, data) {
  const res = await q(
    'INSERT INTO passengers (tg_user_id, first_name, last_name, phone) VALUES ($1,$2,$3,$4) RETURNING *',
    [tgUser.id, data.first_name, data.last_name, data.phone]
  );
  return res.rows[0];
}

async function findNearestDriver(pickup) {
  const blockLimit = Number(process.env.DRIVER_BALANCE_BLOCK_LIMIT || -15);
  const res = await q(
    "SELECT * FROM drivers WHERE status='active' AND online=true AND busy=false AND balance > $1 ORDER BY last_seen DESC NULLS LAST LIMIT 50",
    [blockLimit]
  );

  let best = null;
  let bestKm = Infinity;
  for (const d of res.rows) {
    if (typeof d.last_lat !== 'number' || typeof d.last_lon !== 'number') continue;
    const km = haversineKm(pickup.lat, pickup.lon, d.last_lat, d.last_lon);
    if (km < bestKm) {
      bestKm = km;
      best = { d, km };
    }
  }
  return best;
}

export function buildPassengerBot(driverBotApi) {
  const token = process.env.PASSENGER_BOT_TOKEN;
  if (!token) throw new Error('PASSENGER_BOT_TOKEN missing');
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const p = await ensurePassenger(ctx.from);
    if (p) {
      await ctx.reply(
        `Salam, ${p.first_name || 'istifadəçi'}!\n\n/ride - Taksi sifariş et\n/profile - Profil\n/help - Kömək`
      );
      return;
    }
    passengerFlow.set(ctx.from.id, { step: 'first_name', data: {} });
    await ctx.reply('PayTaksi-yə xoş gəldiniz! Qeydiyyat üçün adınızı yazın:');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply('Komandalar:\n/start - başlanğıc\n/ride - taksi sifariş\n/profile - profil məlumatı');
  });

  bot.command('profile', async (ctx) => {
    const p = await ensurePassenger(ctx.from);
    if (!p) return ctx.reply('Profil tapılmadı. /start');
    await ctx.reply(`Profil:\nAd: ${p.first_name || ''} ${p.last_name || ''}\nTelefon: ${p.phone || ''}`);
  });

  bot.command('ride', async (ctx) => {
    const p = await ensurePassenger(ctx.from);
    if (!p) return ctx.reply('Əvvəl /start ilə qeydiyyatdan keçin.');
    rideFlow.set(ctx.from.id, { step: 'pickup' });
    await ctx.reply(
      'Zəhmət olmasa *götürülmə (pickup)* yerini xəritədən göndərin:',
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([[Markup.button.locationRequest('📍 Pickup göndər')]]).oneTime().resize(),
      }
    );
  });

  bot.on('location', async (ctx) => {
    const rf = rideFlow.get(ctx.from.id);
    if (!rf) return;

    const loc = ctx.message.location;
    if (rf.step === 'pickup') {
      rf.pickup = { lat: loc.latitude, lon: loc.longitude };
      rf.step = 'drop';
      rideFlow.set(ctx.from.id, rf);
      await ctx.reply(
        'İndi *təyinat (drop-off)* yerini göndərin:',
        {
          parse_mode: 'Markdown',
          ...Markup.keyboard([[Markup.button.locationRequest('📍 Drop-off göndər')]]).oneTime().resize(),
        }
      );
      return;
    }

    if (rf.step === 'drop') {
      rf.drop = { lat: loc.latitude, lon: loc.longitude };
      rideFlow.delete(ctx.from.id);

      const p = await ensurePassenger(ctx.from);
      if (!p) return ctx.reply('Profil tapılmadı. /start');

      const nearest = await findNearestDriver(rf.pickup);
      if (!nearest) {
        await ctx.reply('Hazırda yaxınlıqda aktiv sürücü tapılmadı. Bir az sonra yenidən cəhd edin.');
        return;
      }

      const rideRes = await q(
        `INSERT INTO rides (passenger_id, driver_id, status, pickup_lat, pickup_lon, drop_lat, drop_lon)
         VALUES ($1,$2,'requested',$3,$4,$5,$6)
         RETURNING *`,
        [p.id, nearest.d.id, rf.pickup.lat, rf.pickup.lon, rf.drop.lat, rf.drop.lon]
      );
      const ride = rideRes.rows[0];

      await driverBotApi.sendMessage(
        nearest.d.tg_user_id,
        `📣 Yeni sifariş #${ride.id}\nPickup: (${rf.pickup.lat.toFixed(5)}, ${rf.pickup.lon.toFixed(5)})\nDrop: (${rf.drop.lat.toFixed(5)}, ${rf.drop.lon.toFixed(5)})\n\nQəbul edirsiniz?`,
        {
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Qəbul et', `accept:${ride.id}`),
              Markup.button.callback('❌ Rədd et', `reject:${ride.id}`),
            ],
            [Markup.button.url('🧭 Waze aç', `https://waze.com/ul?ll=${rf.pickup.lat},${rf.pickup.lon}&navigate=yes`)],
          ]),
        }
      );

      await ctx.reply(`Sifariş yaradıldı (#${ride.id}). Yaxın sürücüyə göndərildi. Cavab gözləyin…`, Markup.removeKeyboard());
    }
  });

  bot.on('text', async (ctx) => {
    const flow = passengerFlow.get(ctx.from.id);
    if (!flow) return;
    const text = (ctx.message.text || '').trim();

    if (flow.step === 'first_name') {
      flow.data.first_name = text;
      flow.step = 'last_name';
      passengerFlow.set(ctx.from.id, flow);
      return ctx.reply('Soyadınızı yazın:');
    }

    if (flow.step === 'last_name') {
      flow.data.last_name = text;
      flow.step = 'phone';
      passengerFlow.set(ctx.from.id, flow);
      return ctx.reply('Telefon nömrənizi yazın: +994XXXXXXXXX formatında');
    }

    if (flow.step === 'phone') {
      const phone = azPhoneNormalize(text);
      if (!phone) return ctx.reply('Format səhvdir. Məs: +994501234567');
      flow.data.phone = phone;
      const p = await createPassenger(ctx.from, flow.data);
      passengerFlow.delete(ctx.from.id);
      return ctx.reply(`Qeydiyyat tamamlandı ✅\nAd: ${p.first_name} ${p.last_name}\nTelefon: ${p.phone}\n\n/ride - Taksi sifariş et`);
    }
  });

  return bot;
}
