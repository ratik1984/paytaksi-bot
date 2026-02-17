import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { cfg } from '../config.js';
import { q } from '../db.js';
import { haversineKm } from '../utils/geo.js';
import { calcFare } from '../utils/pricing.js';
import { verifyInitData } from '../utils/tgWebApp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function getOrCreateUserFromTg(user, role) {
  // role: 'passenger' | 'driver'
  const tgId = Number(user?.id || 0);
  if (!tgId) return null;

  const existing = await q('SELECT * FROM users WHERE tg_id=$1 LIMIT 1', [tgId]);
  if (existing.rows[0]) {
    // Ensure role exists (do not downgrade)
    if (role && existing.rows[0].role !== role) {
      await q('UPDATE users SET role=$2, updated_at=NOW() WHERE id=$1', [existing.rows[0].id, role]);
    }
    return existing.rows[0];
  }

  const ins = await q(
    `INSERT INTO users(tg_id,role,first_name,last_name,username)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tgId, role, user?.first_name || '', user?.last_name || '', user?.username || '']
  );

  // Create profile row
  if (role === 'passenger') {
    await q('INSERT INTO passenger_profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [ins.rows[0].id]);
  }
  return ins.rows[0];
}

function authFromReq(req, botToken, role) {
  const initData = req.headers['x-telegram-init-data'] || req.query.initData;
  if (initData) {
    const v = verifyInitData(String(initData), botToken);
    if (v.ok) return { ok: true, tgUser: v.user };
    return { ok: false, reason: v.reason || 'unauthorized' };
  }

  // Unsafe dev mode
  if (cfg.allowTgUnsafe) {
    const tgId = Number(req.query.tg_id || 0);
    if (tgId) return { ok: true, tgUser: { id: tgId, first_name: 'Dev', last_name: '', username: '' }, unsafe: true };
  }

  return { ok: false, reason: 'missing_initdata' };
}

export function buildMiniWeb({ passengerBot, driverBot, listEligibleDrivers }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Static assets
  const staticDir = path.join(__dirname, 'static');
  app.use('/mini/static', express.static(staticDir));

  // Pages
  app.get('/mini/passenger', (req, res) => {
    res.sendFile(path.join(staticDir, 'mini-passenger.html'));
  });

  // --- APIs

  app.get('/api/mini/passenger/me', async (req, res) => {
    const a = authFromReq(req, cfg.passengerBotToken, 'passenger');
    if (!a.ok) return res.status(401).json({ ok: false, error: a.reason });
    const u = await getOrCreateUserFromTg(a.tgUser, 'passenger');
    return res.json({ ok: true, user: { id: u.id, tg_id: u.tg_id, first_name: u.first_name, last_name: u.last_name } });
  });

  app.post('/api/mini/passenger/request', async (req, res) => {
    const a = authFromReq(req, cfg.passengerBotToken, 'passenger');
    if (!a.ok) return res.status(401).json({ ok: false, error: a.reason });
    const u = await getOrCreateUserFromTg(a.tgUser, 'passenger');
    if (!u) return res.status(400).json({ ok: false, error: 'user' });

    const pickup = req.body?.pickup;
    const dest = req.body?.dest;
    if (!pickup?.lat || !pickup?.lng || !dest?.lat || !dest?.lng) {
      return res.status(400).json({ ok: false, error: 'coords' });
    }

    const distanceKm = Number(req.body?.distance_km || haversineKm(pickup, dest));
    const fare = calcFare(distanceKm, cfg.pricing);

    const ins = await q(
      `INSERT INTO ride_requests(
        passenger_id,status,
        pickup_lat,pickup_lng,pickup_text,
        dest_lat,dest_lng,dest_text,
        distance_km,fare_azn
      ) VALUES ($1,'searching',$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        u.id,
        pickup.lat,
        pickup.lng,
        String(pickup.text || ''),
        dest.lat,
        dest.lng,
        String(dest.text || ''),
        distanceKm,
        fare,
      ]
    );

    const reqRow = ins.rows[0];

    // Trigger offers to drivers (same logic as bot)
    const drivers = await listEligibleDrivers();
    for (const d of drivers) {
      try {
        await driverBot.sendRideOffer(d.tg_id, reqRow);
      } catch {}
    }

    return res.json({ ok: true, request: { id: reqRow.id, distance_km: Number(reqRow.distance_km), fare_azn: Number(reqRow.fare_azn) } });
  });

  app.post('/api/mini/passenger/cancel', async (req, res) => {
    const a = authFromReq(req, cfg.passengerBotToken, 'passenger');
    if (!a.ok) return res.status(401).json({ ok: false, error: a.reason });
    const u = await getOrCreateUserFromTg(a.tgUser, 'passenger');
    const id = Number(req.body?.request_id || 0);
    if (!id) return res.status(400).json({ ok: false, error: 'id' });
    await q("UPDATE ride_requests SET status='cancelled', updated_at=NOW() WHERE id=$1 AND passenger_id=$2", [id, u.id]);
    return res.json({ ok: true });
  });

  app.get('/api/mini/passenger/status', async (req, res) => {
    const a = authFromReq(req, cfg.passengerBotToken, 'passenger');
    if (!a.ok) return res.status(401).json({ ok: false, error: a.reason });
    const u = await getOrCreateUserFromTg(a.tgUser, 'passenger');
    const id = Number(req.query.request_id || 0);
    if (!id) return res.status(400).json({ ok: false, error: 'id' });

    const rr = await q('SELECT * FROM ride_requests WHERE id=$1 AND passenger_id=$2', [id, u.id]);
    const reqRow = rr.rows[0];
    if (!reqRow) return res.status(404).json({ ok: false, error: 'not_found' });

    const ride = await q('SELECT * FROM rides WHERE request_id=$1 ORDER BY id DESC LIMIT 1', [id]);
    return res.json({ ok: true, request: reqRow, ride: ride.rows[0] || null });
  });

  return app;
}
