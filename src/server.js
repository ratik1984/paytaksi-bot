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
import crypto from 'crypto';

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

// --- Signed token fallback for WebApp auth when Telegram initData is empty ---
// Token: base64url(JSON payload) + '.' + base64url(HMAC_SHA256(payloadB64, WEBHOOK_SECRET))
// Payload: { uid:number, role:'passenger'|'driver'|'admin', iat:number }
function b64urlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}
function signPtToken(uid, role) {
  const payloadObj = { uid: Number(uid), role, iat: Math.floor(Date.now() / 1000) };
  const payloadB64 = b64urlEncode(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payloadB64).digest();
  const sigB64 = b64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}
function verifyPtToken(token) {
  try {
    const [payloadB64, sigB64] = String(token || '').split('.');
    if (!payloadB64 || !sigB64) return { ok: false, reason: 'bad_token_format' };
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payloadB64).digest();
    const got = b64urlDecode(sigB64);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return { ok: false, reason: 'bad_token_signature' };
    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    if (!payload?.uid || !payload?.role || !payload?.iat) return { ok: false, reason: 'bad_token_payload' };
    const age = Math.floor(Date.now() / 1000) - Number(payload.iat);
    if (age < 0 || age > 7 * 24 * 3600) return { ok: false, reason: 'token_expired' };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'token_parse_failed' };
  }
}

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

// Simple telegram notifier (best-effort)
async function sendTelegram(role, chatId, text, extra = {}) {
  try {
    const bot = role === 'passenger' ? passengerBot : role === 'driver' ? driverBot : adminBot;
    if (!bot) return { ok: false, error: 'bot_not_configured' };
    if (!chatId) return { ok: false, error: 'chat_id_required' };
    await bot.telegram.sendMessage(Number(chatId), String(text), extra);
    return { ok: true };
  } catch (e) {
    console.error('sendTelegram failed:', role, e?.message || e);
    return { ok: false, error: 'send_failed' };
  }
}

function webAppButton(text, url) {
  return Markup.keyboard([[Markup.button.webApp(text, url)]])
    .resize()
    .persistent();
}

if (passengerBot) {
  passengerBot.start(async (ctx) => {
    const pt = signPtToken(ctx.from.id, 'passenger');
    const url = `${APP_BASE_URL}/app/passenger/?pt=${encodeURIComponent(pt)}`;
    await ctx.reply('PayTaksi 🚕\nSərnişin paneli açılır:', webAppButton('🚕 Sifariş et', url));
  });
}

if (driverBot) {
  driverBot.start(async (ctx) => {
    const pt = signPtToken(ctx.from.id, 'driver');
    const url = `${APP_BASE_URL}/app/driver/?pt=${encodeURIComponent(pt)}`;
    await ctx.reply('PayTaksi 🚖\nSürücü paneli açılır:', webAppButton('🚖 Sürücü paneli', url));
  });
}

if (adminBot) {
  adminBot.start(async (ctx) => {
    const pt = signPtToken(ctx.from.id, 'admin');
    const url = `${APP_BASE_URL}/app/admin/?pt=${encodeURIComponent(pt)}`;
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

    // Fallback: signed token from query/header (useful if Telegram initData is empty on some clients)
    if (!initData) {
      const pt = req.headers['x-pt-token'] || req.body?.pt || req.query?.pt;
      if (pt) {
        const v = verifyPtToken(pt);
        if (v.ok) {
          if (v.payload.role !== role) {
            return res.status(401).json({ ok: false, error: 'telegram_auth_failed', reason: 'role_mismatch' });
          }
          req.tgInitData = '';
          req.tgUser = { id: Number(v.payload.uid) };
          req.tgUnsafe = true;
          req.ptToken = pt;
          return next();
        }
      }
    }

    // Fallback: allow "unsafe" mode when initData is not present (no hash verification).
    if (!initData) {
      const unsafe = req.headers['x-tg-unsafe'] || req.body?.unsafe;
      if (unsafe) {
        try {
          const parsed = typeof unsafe === 'string' ? JSON.parse(unsafe) : unsafe;
          const user = parsed?.user;
          if (user?.id) {
            req.tgInitData = '';
            req.tgUser = user;
            req.tgUnsafe = true;
            return next();
          }
        } catch (e) {}
      }
      return res.status(401).json({ ok: false, error: 'telegram_auth_failed', reason: 'missing_initData_or_token' });
    }

    const botToken = TOKENS[role];
    const check = validateTelegramWebAppData(initData, botToken);
    if (!check.ok) return res.status(401).json({ ok: false, error: 'telegram_auth_failed', reason: check.reason });
    req.tgInitData = initData;
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    req.tgUser = userJson ? JSON.parse(userJson) : null;
    if (!req.tgUser?.id) return res.status(401).json({ ok: false, error: 'telegram_auth_failed', reason: 'missing_user' });
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

// Nominatim (OSM) sometimes returns HTML error pages (rate-limit, blocks, etc.).
// If we call r.json() directly, it can crash the whole service. This helper prevents that.
async function safeFetchJson(url, fetchOpts = {}) {
  const r = await fetch(url, fetchOpts);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const bodyText = await r.text();

  // Upstream error
  if (!r.ok) {
    const err = new Error(`Upstream HTTP ${r.status}`);
    err.status = r.status;
    err.contentType = ct;
    err.bodyPreview = bodyText.slice(0, 200);
    throw err;
  }

  // Not JSON
  if (!ct.includes('application/json') && !ct.includes('application/geo+json') && !ct.includes('text/json')) {
    const err = new Error('Upstream did not return JSON');
    err.status = r.status;
    err.contentType = ct;
    err.bodyPreview = bodyText.slice(0, 200);
    throw err;
  }

  try {
    return JSON.parse(bodyText);
  } catch (e) {
    const err = new Error('Invalid JSON from upstream');
    err.status = r.status;
    err.contentType = ct;
    err.bodyPreview = bodyText.slice(0, 200);
    throw err;
  }
}

// Very small in-memory cache to reduce Nominatim calls (helps with rate limits)
// Key -> { exp:number, data:any }
const _geoCache = new Map();
function cacheGet(key) {
  const v = _geoCache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    _geoCache.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data, ttlMs = 60_000) {
  // keep cache small
  if (_geoCache.size > 400) {
    const first = _geoCache.keys().next().value;
    if (first) _geoCache.delete(first);
  }
  _geoCache.set(key, { exp: Date.now() + ttlMs, data });
}

// ---- Geocoding helpers (Nominatim primary, Photon fallback)
async function reverseGeocode(lat, lon) {
  // 1) Nominatim
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');
    const j = await safeFetchJson(url.toString(), {
      headers: {
        'User-Agent': 'PayTaksi-MVP/1.0',
        'Accept-Language': 'az,en;q=0.8,ru;q=0.7'
      }
    });
    return j;
  } catch (e) {
    // fall through
  }

  // 2) Photon reverse
  try {
    const url = new URL('https://photon.komoot.io/reverse');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    const j = await safeFetchJson(url.toString(), {
      headers: {
        'User-Agent': 'PayTaksi-MVP/1.0'
      }
    });
    return j;
  } catch (e) {
    return null;
  }
}

function photonFeatureToItem(f) {
  const p = (f && f.properties) || {};
  const c = (f && f.geometry && f.geometry.coordinates) || [];
  const titleParts = [p.name, p.street, p.housenumber, p.district, p.city, p.state, p.country].filter(Boolean);
  return {
    title: titleParts.join(' ').trim() || p.name || 'Yer',
    lat: Number(c[1]),
    lon: Number(c[0])
  };
}

async function searchPlaces(q, lat, lon) {
  // 1) Nominatim
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '10');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('countrycodes', 'az');
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      url.searchParams.set('viewbox', `${lon - 0.2},${lat + 0.2},${lon + 0.2},${lat - 0.2}`);
      url.searchParams.set('bounded', '0');
    }
    const data = await safeFetchJson(url.toString(), {
      headers: {
        'User-Agent': 'PayTaksi-MVP/1.0',
        'Accept-Language': 'az,en;q=0.8,ru;q=0.7'
      }
    });
    const items = (data || []).map((x) => ({
      title: x.display_name,
      lat: Number(x.lat),
      lon: Number(x.lon)
    }));
    if (items && items.length) return items;
  } catch (e) {
    // fall through
  }

  // 2) Photon search
  try {
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '10');
    // Photon doesn't have strict countrycodes, but we can bias to Baku area with lat/lon
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lon));
    }
    const j = await safeFetchJson(url.toString(), {
      headers: {
        'User-Agent': 'PayTaksi-MVP/1.0'
      }
    });
    const feats = (j && j.features) || [];
    const items = feats.map(photonFeatureToItem).filter((it) => Number.isFinite(it.lat) && Number.isFinite(it.lon));
    return items;
  } catch (e) {
    return [];
  }
}

app.get('/api/reverse', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return res.status(400).json({ ok: false, error: 'lat/lon required' });

    const j = await reverseGeocode(lat, lon);
    if (!j) return res.json({ ok: true, name: '', display_name: '' });

    // Nominatim style
    if (j && (j.display_name || j.name || j.address)) {
      const name =
        (j && j.name) ||
        (j && j.address && (j.address.road || j.address.neighbourhood || j.address.suburb || j.address.city_district || j.address.city)) ||
        (j && j.display_name) ||
        '';
      return res.json({ ok: true, name, display_name: j.display_name || '' });
    }

    // Photon style
    if (j && j.features && j.features[0]) {
      const it = photonFeatureToItem(j.features[0]);
      return res.json({ ok: true, name: it.title || '', display_name: it.title || '' });
    }

    res.json({ ok: true, name: '', display_name: '' });
  } catch (e) {
    console.error('reverse geocode failed:', e.message, e.status || '', e.contentType || '', e.bodyPreview || '');
    // Don't break the app if reverse fails.
    res.json({ ok: true, name: '', display_name: '' });
  }
});

app.get('/api/places', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!q || q.length < 3) return res.json({ ok: true, items: [] });

    // Prefer Azerbaijan results; also add a light "Azerbaijan" context if user didn't type it.
    let q2 = q;
    const qLower = q2.toLowerCase();
    const hasAz = qLower.includes('azerba') || qLower.includes('azərbay') || qLower.includes('bakı') || qLower.includes('baki');
    if (!hasAz) q2 = `${q2}, Azerbaijan`;

    const cacheKey = `places:${q2}|${Number.isNaN(lat) ? '' : lat.toFixed(4)}|${Number.isNaN(lon) ? '' : lon.toFixed(4)}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ok: true, items: cached });

    const items = await searchPlaces(q2, lat, lon);
    cacheSet(cacheKey, items, 60_000);
    res.json({ ok: true, items });
  } catch (e) {
    console.error('places search failed:', e.message, e.status || '', e.contentType || '', e.bodyPreview || '');
    // Return empty suggestions instead of crashing the whole service.
    res.json({ ok: true, items: [] });
  }
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
app.post('/api/passenger/cancel_ride', requireTelegram('passenger'), async (req, res) => {
  try {
    const ride_id = Number(req.body?.ride_id);
    const reason = String(req.body?.reason || '').trim().slice(0, 200) || null;
    if (!ride_id) return res.status(400).json({ ok: false, error: 'ride_id_required' });

    const passenger = await upsertUser(req.tgUser, 'passenger');

    // Lock ONLY the rides row (Postgres doesn't allow FOR UPDATE on the nullable side of LEFT JOIN)
    const client = await pool.connect();
    let ride;
    try {
      await client.query('BEGIN');

      const rideQ = await client.query(
        `SELECT *
         FROM rides
         WHERE id=$1 AND passenger_user_id=$2
         FOR UPDATE`,
        [ride_id, passenger.id]
      );
      ride = rideQ.rows[0];

      if (!ride) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'ride_not_found' });
      }

      if (!['searching', 'assigned'].includes(ride.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'cannot_cancel', status: ride.status });
      }

      // Backward compatible update: if cancel columns are not present, fall back to status only.
      // NOTE: In Postgres, any error inside a transaction aborts it; use SAVEPOINT to recover.
      await client.query('SAVEPOINT cancel_cols');
      try {
        const upd = await client.query(
          `UPDATE rides
           SET status='cancelled', updated_at=NOW(), cancelled_at=NOW(), cancelled_by='passenger', cancelled_reason=$2
           WHERE id=$1
           RETURNING *`,
          [ride_id, reason]
        );
        ride = { ...ride, ...upd.rows[0] };
      } catch (e2) {
        // 42703 = undefined_column
        if (e2 && e2.code === '42703') {
          await client.query('ROLLBACK TO SAVEPOINT cancel_cols');
          const upd = await client.query(
            `UPDATE rides
             SET status='cancelled', updated_at=NOW()
             WHERE id=$1
             RETURNING *`,
            [ride_id]
          );
          ride = { ...ride, ...upd.rows[0] };
        } else {
          throw e2;
        }
      }

      // Best-effort cancellation audit log for admin statistics.
      // Must never break cancellation flow if the table doesn't exist.
      await client.query('SAVEPOINT cancel_audit');
      try {
        await client.query(
          `INSERT INTO ride_cancellations (ride_id, actor_role, actor_tg_id, reason)
           VALUES ($1,'passenger',$2,$3)`,
          [ride_id, Number(req.tgUser?.id) || null, reason]
        );
      } catch (e3) {
        // 42P01 = undefined_table
        if (e3 && e3.code === '42P01') {
          await client.query('ROLLBACK TO SAVEPOINT cancel_audit');
        } else {
          throw e3;
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }

    // Notify driver if already assigned (best-effort)
    if (ride.driver_id) {
      const dQ = await pool.query(
        `SELECT u.tg_id as driver_tg_id, u.first_name as driver_first_name, u.username as driver_username
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         WHERE d.id=$1`,
        [ride.driver_id]
      );
      const d = dQ.rows?.[0];
      if (d?.driver_tg_id) {
        const msg = `❌ Sifariş ləğv edildi (#${ride_id}).\n\n📍 ${ride.pickup_text || ''}\n➡️ ${ride.drop_text || ''}${reason ? `\n\nSəbəb: ${reason}` : ''}`;
        // Explicitly keep notifications enabled (sound if user hasn't muted the chat)
        await sendTelegram('driver', d.driver_tg_id, msg, { disable_notification: false });
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('cancel_ride error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---- Admin: cancellation statistics (top reasons)
app.get('/api/admin/cancel_stats', adminAuth, async (req, res) => {
  const daysRaw = String(req.query?.days || '30');
  const days = daysRaw === 'all' ? null : Math.max(1, Math.min(365, Number(daysRaw) || 30));
  const fromExpr = days ? `NOW() - ($1::int * INTERVAL '1 day')` : null;

  // Try the audit table first; if it doesn't exist, fall back to rides.cancelled_reason when present.
  try {
    if (days) {
      const q = await pool.query(
        `SELECT COALESCE(NULLIF(TRIM(reason), ''), '(Səbəb göstərilməyib)') AS reason,
                COUNT(*)::int AS c
         FROM ride_cancellations
         WHERE created_at >= ${fromExpr}
         GROUP BY 1
         ORDER BY c DESC, reason ASC
         LIMIT 50`,
        [days]
      );
      return res.json({ ok: true, source: 'ride_cancellations', days, items: q.rows });
    } else {
      const q = await pool.query(
        `SELECT COALESCE(NULLIF(TRIM(reason), ''), '(Səbəb göstərilməyib)') AS reason,
                COUNT(*)::int AS c
         FROM ride_cancellations
         GROUP BY 1
         ORDER BY c DESC, reason ASC
         LIMIT 50`
      );
      return res.json({ ok: true, source: 'ride_cancellations', days: 'all', items: q.rows });
    }
  } catch (e1) {
    if (!(e1 && e1.code === '42P01')) {
      console.error('cancel_stats audit query error:', e1);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  }

  // Fallback: rides.cancelled_reason (if column exists)
  try {
    if (days) {
      const q = await pool.query(
        `SELECT COALESCE(NULLIF(TRIM(cancelled_reason), ''), '(Səbəb göstərilməyib)') AS reason,
                COUNT(*)::int AS c
         FROM rides
         WHERE status='cancelled' AND updated_at >= ${fromExpr}
         GROUP BY 1
         ORDER BY c DESC, reason ASC
         LIMIT 50`,
        [days]
      );
      return res.json({ ok: true, source: 'rides.cancelled_reason', days, items: q.rows });
    } else {
      const q = await pool.query(
        `SELECT COALESCE(NULLIF(TRIM(cancelled_reason), ''), '(Səbəb göstərilməyib)') AS reason,
                COUNT(*)::int AS c
         FROM rides
         WHERE status='cancelled'
         GROUP BY 1
         ORDER BY c DESC, reason ASC
         LIMIT 50`
      );
      return res.json({ ok: true, source: 'rides.cancelled_reason', days: 'all', items: q.rows });
    }
  } catch (e2) {
    // 42703 = undefined_column
    if (e2 && e2.code === '42703') {
      return res.json({ ok: true, source: 'none', days: days || 'all', items: [] });
    }
    console.error('cancel_stats rides query error:', e2);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

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
  // Backward-compatible alias used by the passenger UI
  const rides = (q.rows || []).map((r) => ({ ...r, driver_name: r.driver_first_name || null }));
  res.json({ ok: true, rides });
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

// driver: active (assigned/started/cancelled) ride for quick status view in the webapp
app.get('/api/driver/active_ride', requireTelegram('driver'), async (req, res) => {
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  if (!driver) return res.status(400).json({ ok: false, error: 'not_registered' });

  // Show latest relevant ride (even if cancelled) so driver can see the cancellation message in-app
  const rQ = await pool.query(
    `SELECT *
     FROM rides
     WHERE driver_id=$1 AND status IN ('assigned','started','cancelled')
     ORDER BY id DESC
     LIMIT 1`,
    [driver.id]
  );
  res.json({ ok: true, ride: rQ.rows[0] || null });
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
