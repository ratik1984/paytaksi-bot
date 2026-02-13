import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import multer from 'multer';
import { pool } from './db.js';
import { validateTelegramWebAppData } from './telegramAuth.js';
import { Telegraf, Markup } from 'telegraf';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // Telegram WebApp needs relaxed CSP for MVP
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---- Config
const APP_BASE_URL = process.env.APP_BASE_URL; // e.g. https://paytaksi-telegram.onrender.com
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'CHANGE_ME_SECRET';

const TOKENS = {
  passenger: process.env.PASSENGER_BOT_TOKEN,
  driver: process.env.DRIVER_BOT_TOKEN,
  admin: process.env.ADMIN_BOT_TOKEN
};

for (const k of Object.keys(TOKENS)) {
  if (!TOKENS[k]) console.warn(`⚠️ Missing ${k} bot token env var`);
}
if (!APP_BASE_URL) console.warn('⚠️ Missing APP_BASE_URL env var');

const COMMISSION_RATE = 0.10;
const BASE_FARE = 3.50;
const BASE_KM = 3.0;
const PER_KM_AFTER = 0.40;
const DRIVER_BLOCK_AT = -10.0;

function money2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function calcFare(distanceKm) {
  if (distanceKm <= BASE_KM) return money2(BASE_FARE);
  const extra = (distanceKm - BASE_KM) * PER_KM_AFTER;
  return money2(BASE_FARE + extra);
}

async function ensureSchema() {
  const { default: fs } = await import('fs');
  const schema = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
  await pool.query(schema);
}

// ---- Uploads (Render disk is ephemeral; ok for MVP/testing)
const uploadDir = path.resolve('uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  }
});
const upload = multer({ storage });

// ---- Static web apps
app.use('/uploads', express.static(uploadDir));
app.use('/app', express.static(path.join(__dirname, 'public')));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Telegram bots (webhook mode)
const passengerBot = TOKENS.passenger ? new Telegraf(TOKENS.passenger) : null;
const driverBot = TOKENS.driver ? new Telegraf(TOKENS.driver) : null;
const adminBot = TOKENS.admin ? new Telegraf(TOKENS.admin) : null;

function webAppButton(text, url) {
  return Markup.keyboard([[Markup.button.webApp(text, url)]])
    .resize()
    .persistent();
}

if (passengerBot) {
  passengerBot.start(async (ctx) => {
    const url = `${APP_BASE_URL}/app/passenger/`;
    await ctx.reply('PayTaksi 🚕\nSərnişin paneli açılır:', webAppButton('🚕 Sifariş et', url));
  });
}

if (driverBot) {
  driverBot.start(async (ctx) => {
    const url = `${APP_BASE_URL}/app/driver/`;
    await ctx.reply('PayTaksi 🚖\nSürücü paneli açılır:', webAppButton('🚖 Sürücü paneli', url));
  });
}

if (adminBot) {
  adminBot.start(async (ctx) => {
    const url = `${APP_BASE_URL}/app/admin/`;
    await ctx.reply('PayTaksi 🛠\nAdmin panel açılır:', webAppButton('🛠 Admin panel', url));
  });
}

// Webhook endpoints (secret path)
if (passengerBot) app.use(passengerBot.webhookCallback(`/webhook/${WEBHOOK_SECRET}/passenger`));
if (driverBot) app.use(driverBot.webhookCallback(`/webhook/${WEBHOOK_SECRET}/driver`));
if (adminBot) app.use(adminBot.webhookCallback(`/webhook/${WEBHOOK_SECRET}/admin`));

// ---- Telegram WebApp auth middleware
function requireTelegram(role) {
  return (req, res, next) => {
    const initData = req.headers['x-tg-initdata'] || req.body?.initData || req.query?.initData;
    const botToken = TOKENS[role];
    const check = validateTelegramWebAppData(initData, botToken);
    if (!check.ok) return res.status(401).json({ ok: false, error: 'telegram_auth_failed', reason: check.reason });
    req.tgInitData = initData;
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    req.tgUser = userJson ? JSON.parse(userJson) : null;
    if (!req.tgUser?.id) return res.status(401).json({ ok: false, error: 'no_user' });
    next();
  };
}

async function upsertUser(tgUser, role) {
  const { id: tg_id, first_name, last_name, username } = tgUser;
  const q = await pool.query(
    `INSERT INTO users (tg_id, role, first_name, last_name, username)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tg_id) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, username=EXCLUDED.username
     RETURNING *`,
    [tg_id, role, first_name || null, last_name || null, username || null]
  );
  return q.rows[0];
}

// ---- Places autocomplete (OpenStreetMap Nominatim)

app.get('/api/reverse', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return res.status(400).json({ ok: false, error: 'lat/lon required' });

    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');

    const r = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'PayTaksi-MVP/1.0 (contact: admin@example.com)',
        'Accept-Language': 'az,en;q=0.8,ru;q=0.7'
      }
    });
    const j = await r.json();
    const name =
      (j && j.name) ||
      (j && j.address && (j.address.road || j.address.neighbourhood || j.address.suburb || j.address.city_district || j.address.city)) ||
      (j && j.display_name) ||
      '';
    res.json({ ok: true, name, display_name: j.display_name || '' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'reverse_failed' });
  }
});

app.get('/api/places', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!q || q.length < 3) return res.json({ ok: true, items: [] });

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '6');
  url.searchParams.set('addressdetails', '1');
  if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
    url.searchParams.set('viewbox', `${lon-0.2},${lat+0.2},${lon+0.2},${lat-0.2}`);
    url.searchParams.set('bounded', '1');
  }

  const r = await fetch(url.toString(), {
    headers: { 'User-Agent': 'PayTaksi-MVP/1.0 (contact: admin@example.com)', 'Accept-Language': 'az,en;q=0.8,ru;q=0.7' }
  });
  const data = await r.json();
  const items = (data || []).map((x) => ({
    title: x.display_name,
    lat: Number(x.lat),
    lon: Number(x.lon)
  }));
  res.json({ ok: true, items });
});

// ---- Passenger: create ride
app.post('/api/passenger/create_ride', requireTelegram('passenger'), async (req, res) => {
  const { pickup_lat, pickup_lon, pickup_text, drop_lat, drop_lon, drop_text } = req.body || {};
  if ([pickup_lat, pickup_lon, drop_lat, drop_lon].some((v) => typeof v !== 'number')) {
    return res.status(400).json({ ok: false, error: 'bad_coords' });
  }

  const passenger = await upsertUser(req.tgUser, 'passenger');

  const dist = haversineKm(pickup_lat, pickup_lon, drop_lat, drop_lon);
  const fare = calcFare(dist);
  const commission = money2(fare * COMMISSION_RATE);

  const rideQ = await pool.query(
    `INSERT INTO rides
     (passenger_user_id, pickup_lat, pickup_lon, pickup_text, drop_lat, drop_lon, drop_text, distance_km, fare, commission)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [passenger.id, pickup_lat, pickup_lon, pickup_text || null, drop_lat, drop_lon, drop_text || null, dist, fare, commission]
  );
  res.json({ ok: true, ride: rideQ.rows[0] });
});

// passenger: check ride status
app.get('/api/passenger/my_rides', requireTelegram('passenger'), async (req, res) => {
  const passenger = await upsertUser(req.tgUser, 'passenger');
  const q = await pool.query(
    `SELECT r.*, d.id as driver_id, u.tg_id as driver_tg_id, u.first_name as driver_first_name, u.username as driver_username
     FROM rides r
     LEFT JOIN drivers d ON d.id = r.driver_id
     LEFT JOIN users u ON u.id = d.user_id
     WHERE r.passenger_user_id=$1
     ORDER BY r.id DESC
     LIMIT 10`,
    [passenger.id]
  );
  res.json({ ok: true, rides: q.rows });
});

// ---- Driver: register + upload docs
app.post(
  '/api/driver/register',
  requireTelegram('driver'),
  upload.fields([
    { name: 'id_front', maxCount: 1 },
    { name: 'id_back', maxCount: 1 },
    { name: 'dl_front', maxCount: 1 },
    { name: 'dl_back', maxCount: 1 },
    { name: 'tp_front', maxCount: 1 },
    { name: 'tp_back', maxCount: 1 }
  ]),
  async (req, res) => {
    const body = req.body || {};
    const car_year = Number(body.car_year);
    const car_color = String(body.car_color || '').trim();
    const allowedColors = new Set(['ağ','qara','qırmızı','boz','mavi','sarı','yaşıl']);

    if (!Number.isFinite(car_year) || car_year < 2010) return res.status(400).json({ ok: false, error: 'car_year_min_2010' });
    if (!allowedColors.has(car_color)) return res.status(400).json({ ok: false, error: 'bad_color' });

    const user = await upsertUser(req.tgUser, 'driver');

    // create driver row
    const drvQ = await pool.query(
      `INSERT INTO drivers (user_id, phone, car_make, car_model, car_year, car_color, plate)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET phone=EXCLUDED.phone, car_make=EXCLUDED.car_make, car_model=EXCLUDED.car_model, car_year=EXCLUDED.car_year, car_color=EXCLUDED.car_color, plate=EXCLUDED.plate
       RETURNING *`,
      [user.id, body.phone || null, body.car_make || null, body.car_model || null, car_year, car_color, body.plate || null]
    );
    const driver = drvQ.rows[0];

    const files = req.files || {};
    const expected = ['id_front','id_back','dl_front','dl_back','tp_front','tp_back'];
    for (const t of expected) {
      const f = files[t]?.[0];
      if (!f) continue;
      await pool.query(
        `INSERT INTO driver_documents (driver_id, doc_type, file_path)
         VALUES ($1,$2,$3)
         ON CONFLICT (driver_id, doc_type) DO UPDATE SET file_path=EXCLUDED.file_path, uploaded_at=NOW()`,
        [driver.id, t, `/uploads/${path.basename(f.path)}`]
      );
    }

    res.json({ ok: true, driver });
  }
);

// driver: me
app.get('/api/driver/me', requireTelegram('driver'), async (req, res) => {
  const user = await upsertUser(req.tgUser, 'driver');
  const q = await pool.query(
    `SELECT d.*, (SELECT json_agg(dd.*) FROM driver_documents dd WHERE dd.driver_id=d.id) as documents
     FROM drivers d WHERE d.user_id=$1`,
    [user.id]
  );
  res.json({ ok: true, driver: q.rows[0] || null, blockAt: DRIVER_BLOCK_AT });
});

// driver: list searching rides (simple)
app.get('/api/driver/open_rides', requireTelegram('driver'), async (req, res) => {
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  if (!driver) return res.status(400).json({ ok: false, error: 'not_registered' });
  if (driver.status !== 'approved') return res.json({ ok: true, rides: [], note: 'not_approved' });
  if (Number(driver.balance) <= DRIVER_BLOCK_AT) return res.json({ ok: true, rides: [], note: 'balance_blocked' });

  const q = await pool.query(`SELECT * FROM rides WHERE status='searching' ORDER BY id DESC LIMIT 10`);
  res.json({ ok: true, rides: q.rows });
});

// driver: accept ride
app.post('/api/driver/accept', requireTelegram('driver'), async (req, res) => {
  const { ride_id } = req.body || {};
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  if (!driver) return res.status(400).json({ ok: false, error: 'not_registered' });
  if (driver.status !== 'approved') return res.status(403).json({ ok: false, error: 'not_approved' });
  if (Number(driver.balance) <= DRIVER_BLOCK_AT) return res.status(403).json({ ok: false, error: 'balance_blocked' });

  const rideQ = await pool.query(
    `UPDATE rides SET driver_id=$1, status='assigned', updated_at=NOW()
     WHERE id=$2 AND status='searching'
     RETURNING *`,
    [driver.id, ride_id]
  );
  if (!rideQ.rows[0]) return res.status(409).json({ ok: false, error: 'ride_not_available' });
  res.json({ ok: true, ride: rideQ.rows[0] });
});

// driver: start
app.post('/api/driver/start', requireTelegram('driver'), async (req, res) => {
  const { ride_id } = req.body || {};
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  const q = await pool.query(
    `UPDATE rides SET status='started', updated_at=NOW()
     WHERE id=$1 AND driver_id=$2 AND status='assigned'
     RETURNING *`,
    [ride_id, driver?.id]
  );
  if (!q.rows[0]) return res.status(409).json({ ok: false, error: 'cannot_start' });
  res.json({ ok: true, ride: q.rows[0] });
});

// driver: complete (apply 10% commission to driver balance)
app.post('/api/driver/complete', requireTelegram('driver'), async (req, res) => {
  const { ride_id } = req.body || {};
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  if (!driver) return res.status(400).json({ ok: false, error: 'not_registered' });

  const rideQ = await pool.query(`SELECT * FROM rides WHERE id=$1 AND driver_id=$2`, [ride_id, driver.id]);
  const ride = rideQ.rows[0];
  if (!ride || ride.status !== 'started') return res.status(409).json({ ok: false, error: 'cannot_complete' });

  const commission = Number(ride.commission);
  const newBal = money2(Number(driver.balance) - commission);

  await pool.query('BEGIN');
  try {
    await pool.query(`UPDATE rides SET status='completed', updated_at=NOW() WHERE id=$1`, [ride_id]);
    await pool.query(`UPDATE drivers SET balance=$1 WHERE id=$2`, [newBal, driver.id]);
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }

  res.json({ ok: true, commission, new_balance: newBal, blocked: newBal <= DRIVER_BLOCK_AT });
});

// driver: topup request (manual approval)
app.post('/api/driver/topup_request', requireTelegram('driver'), async (req, res) => {
  const { amount, method, reference } = req.body || {};
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  if (!driver) return res.status(400).json({ ok: false, error: 'not_registered' });

  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return res.status(400).json({ ok: false, error: 'bad_amount' });

  const m = String(method || '');
  if (!['kart-to-kart','m10'].includes(m)) return res.status(400).json({ ok: false, error: 'bad_method' });

  const q = await pool.query(
    `INSERT INTO topup_requests (driver_id, amount, method, reference) VALUES ($1,$2,$3,$4) RETURNING *`,
    [driver.id, money2(a), m, reference || null]
  );
  res.json({ ok: true, topup: q.rows[0] });
});

// ---- Admin (basic auth for MVP)
function adminAuth(req, res, next) {
  const user = process.env.ADMIN_WEB_USER || 'Ratik';
  const pass = process.env.ADMIN_WEB_PASS || '0123456789';

  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) return unauthorized(res);
  const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  if (u === user && p === pass) return next();
  return unauthorized(res);

  function unauthorized(res) {
    res.set('WWW-Authenticate', 'Basic realm="PayTaksi Admin"');
    return res.status(401).send('Auth required');
  }
}

app.get('/api/admin/summary', adminAuth, async (req, res) => {
  const [driversPending, topupsPending, ridesOpen] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int c FROM drivers WHERE status='pending'`),
    pool.query(`SELECT COUNT(*)::int c FROM topup_requests WHERE status='pending'`),
    pool.query(`SELECT COUNT(*)::int c FROM rides WHERE status IN ('searching','assigned','started')`)
  ]);
  res.json({
    ok: true,
    drivers_pending: driversPending.rows[0].c,
    topups_pending: topupsPending.rows[0].c,
    rides_open: ridesOpen.rows[0].c
  });
});

app.get('/api/admin/drivers', adminAuth, async (req, res) => {
  const q = await pool.query(
    `SELECT d.*, u.tg_id, u.first_name, u.username,
        (SELECT json_agg(dd.*) FROM driver_documents dd WHERE dd.driver_id=d.id) as documents
     FROM drivers d JOIN users u ON u.id=d.user_id
     ORDER BY d.id DESC LIMIT 100`
  );
  res.json({ ok: true, drivers: q.rows });
});

app.post('/api/admin/driver_status', adminAuth, async (req, res) => {
  const { driver_id, status, note } = req.body || {};
  if (!['pending','approved','rejected','blocked'].includes(status)) return res.status(400).json({ ok: false, error: 'bad_status' });
  const q = await pool.query(`UPDATE drivers SET status=$1 WHERE id=$2 RETURNING *`, [status, driver_id]);
  res.json({ ok: true, driver: q.rows[0] || null, note: note || null });
});

app.get('/api/admin/topups', adminAuth, async (req, res) => {
  const q = await pool.query(
    `SELECT t.*, d.user_id, u.tg_id, u.first_name, u.username
     FROM topup_requests t
     JOIN drivers d ON d.id=t.driver_id
     JOIN users u ON u.id=d.user_id
     ORDER BY t.id DESC LIMIT 200`
  );
  res.json({ ok: true, topups: q.rows });
});

app.post('/api/admin/topup_review', adminAuth, async (req, res) => {
  const { topup_id, action, note } = req.body || {};
  if (!['approve','reject'].includes(action)) return res.status(400).json({ ok: false, error: 'bad_action' });

  await pool.query('BEGIN');
  try {
    const tQ = await pool.query(`SELECT * FROM topup_requests WHERE id=$1 FOR UPDATE`, [topup_id]);
    const t = tQ.rows[0];
    if (!t) throw new Error('topup_not_found');
    if (t.status !== 'pending') throw new Error('already_reviewed');

    if (action === 'approve') {
      const dQ = await pool.query(`SELECT * FROM drivers WHERE id=$1 FOR UPDATE`, [t.driver_id]);
      const d = dQ.rows[0];
      const newBal = money2(Number(d.balance) + Number(t.amount));
      await pool.query(`UPDATE drivers SET balance=$1 WHERE id=$2`, [newBal, d.id]);
      await pool.query(`UPDATE topup_requests SET status='approved', reviewed_at=NOW(), note=$2 WHERE id=$1`, [t.id, note || null]);
    } else {
      await pool.query(`UPDATE topup_requests SET status='rejected', reviewed_at=NOW(), note=$2 WHERE id=$1`, [t.id, note || null]);
    }

    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }

  res.json({ ok: true });
});

app.get('/api/admin/rides', adminAuth, async (req, res) => {
  const q = await pool.query(
    `SELECT r.*, pu.tg_id as passenger_tg_id, pu.first_name as passenger_name,
            du.tg_id as driver_tg_id, du.first_name as driver_name
     FROM rides r
     JOIN users pu ON pu.id = r.passenger_user_id
     LEFT JOIN drivers d ON d.id = r.driver_id
     LEFT JOIN users du ON du.id = d.user_id
     ORDER BY r.id DESC LIMIT 200`
  );
  res.json({ ok: true, rides: q.rows });
});

// ---- Start server
const PORT = process.env.PORT || 10000;

await ensureSchema();

app.listen(PORT, () => {
  console.log(`PayTaksi server listening on :${PORT}`);
  console.log(`Webhook secret path: /webhook/${WEBHOOK_SECRET}/...`);
});
