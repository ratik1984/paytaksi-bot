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
import bcrypt from 'bcryptjs';

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
const OFFER_TIMEOUT_SEC = Number(process.env.OFFER_TIMEOUT_SEC || 20);

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

// Unified Telegram sender used across patches (additive).
async function sendTelegramToRole(role, tgId, text, extra = {}) {
  try {
    const bot = role === 'passenger' ? passengerBot : role === 'driver' ? driverBot : role === 'admin' ? adminBot : null;
    if (!bot) return;
    await bot.telegram.sendMessage(Number(tgId), String(text), {
      disable_web_page_preview: true,
      disable_notification: false,
      ...extra
    });
  } catch (e) {
    // best-effort
  }
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

// ---- Driver auth (registration -> login -> driver area)
// DB tables required: driver_credentials, driver_sessions (see SQL patch)
const DRIVER_SESSION_DAYS = Number(process.env.DRIVER_SESSION_DAYS || 30);

// Some deployments forget to apply the SQL patch for driver auth tables.
// To avoid breaking registration/login, we lazily ensure these tables exist.
async function ensureDriverAuthTables(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_credentials (
      driver_id INTEGER PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_sessions (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_driver_sessions_driver_id ON driver_sessions(driver_id);
    CREATE INDEX IF NOT EXISTS idx_driver_sessions_token ON driver_sessions(token);
  `);
}

// ---- Driver online/offline (additive; optional columns)
let _driversOnlineCols = null;
async function driversHaveOnlineCols(){
  if (_driversOnlineCols !== null) return _driversOnlineCols;
  try{
    const q = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name='drivers' AND column_name='is_online'
       LIMIT 1`
    );
    _driversOnlineCols = !!q.rows[0];
  }catch(_){
    _driversOnlineCols = false;
  }
  return _driversOnlineCols;
}

// ---- Auto dispatch (round-robin with optional nearest if driver location exists)
let _driversLocCols = null;
async function driversHaveLocationCols(){
  if (_driversLocCols !== null) return _driversLocCols;
  try{
    const q = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name='drivers' AND column_name='last_lat'
       LIMIT 1`
    );
    _driversLocCols = !!q.rows[0];
  }catch(_){
    _driversLocCols = false;
  }
  return _driversLocCols;
}

async function ensureDispatchTables(){
  // Additive: driver last known location (used for nearest dispatch if available)
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION;`).catch(()=>{});
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION;`).catch(()=>{});
  // Additive: driver location freshness (optional)
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_loc_at TIMESTAMPTZ;`).catch(()=>{});
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_loc_accuracy DOUBLE PRECISION;`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_drivers_last_latlon ON drivers(last_lat, last_lon);`).catch(()=>{});

  // Additive: single-row dispatch state
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_state (
      id INT PRIMARY KEY DEFAULT 1,
      last_driver_id BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).catch(()=>{});
  await pool.query(`INSERT INTO dispatch_state(id,last_driver_id) VALUES (1,NULL) ON CONFLICT (id) DO NOTHING;`).catch(()=>{});
  // --- Offer/timeout dispatch (additive)
  await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS offered_driver_id BIGINT;`).catch(()=>{});
  await pool.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ;`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rides_offer_expires ON rides(offer_expires_at);`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS ride_offer_attempts (
    id BIGSERIAL PRIMARY KEY,
    ride_id BIGINT NOT NULL,
    driver_id BIGINT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('reject','timeout','accept')),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_offer_attempts_ride ON ride_offer_attempts(ride_id, driver_id);`).catch(()=>{});

}

function dist2(aLat, aLon, bLat, bLon){
  const dx = Number(aLat) - Number(bLat);
  const dy = Number(aLon) - Number(bLon);
  return dx*dx + dy*dy;
}

async function autoAssignRide(rideId){
  await ensureDispatchTables();
startOfferExpiryLoop();
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    // One-at-a-time dispatcher lock
    await client.query('SELECT pg_advisory_xact_lock(424242)');

    const rideQ = await client.query(
      `SELECT id, status, pickup_lat, pickup_lon, pickup_text, drop_text, distance_km, fare, offered_driver_id, offer_expires_at
       FROM rides WHERE id=$1 FOR UPDATE`,
      [rideId]
    );
    const ride = rideQ.rows[0];
    if (!ride || ride.status !== 'searching') {
      await client.query('COMMIT');
      return null;
    }
    // If an unexpired offer already exists, don't re-offer yet
    if (ride.offered_driver_id && ride.offer_expires_at && new Date(ride.offer_expires_at).getTime() > Date.now()) {
      await client.query('COMMIT');
      return null;
    }

    const driversQ = await client.query(
      `SELECT d.id, d.last_lat, d.last_lon, d.balance,
              u.tg_id AS driver_tg_id, u.first_name AS driver_first_name, u.username AS driver_username
       FROM drivers d
       JOIN users u ON u.id = d.user_id
       WHERE d.status='approved'
         AND COALESCE(d.is_online,false)=true
         AND d.balance > $1
         AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.driver_id=d.id AND r.status IN ('assigned','started'))
       ORDER BY d.id ASC`,
      [DRIVER_BLOCK_AT, ride.id]
    );
    const drivers = driversQ.rows;
    if (!drivers.length) {
      await client.query('COMMIT');
      return null;
    }

    // Choose driver: nearest if location exists; else round-robin
    const hasLoc = await driversHaveLocationCols();
    const withLoc = hasLoc ? drivers.filter(d => d.last_lat !== null && d.last_lon !== null) : [];
    let chosen = null;

    if (withLoc.length) {
      chosen = withLoc.reduce((best, d) => {
        if (!best) return d;
        const bd = dist2(ride.pickup_lat, ride.pickup_lon, best.last_lat, best.last_lon);
        const dd = dist2(ride.pickup_lat, ride.pickup_lon, d.last_lat, d.last_lon);
        return dd < bd ? d : best;
      }, null);
    } else {
      const stQ = await client.query('SELECT last_driver_id FROM dispatch_state WHERE id=1 FOR UPDATE');
      const last = stQ.rows[0]?.last_driver_id ?? null;
      chosen = drivers.find(d => last === null || Number(d.id) > Number(last)) || drivers[0];
      await client.query('UPDATE dispatch_state SET last_driver_id=$1, updated_at=NOW() WHERE id=1', [chosen.id]);
    }

    const upd = await client.query(
      `UPDATE rides
       SET offered_driver_id=$1, offer_expires_at=NOW() + ($3 || ' seconds')::interval, updated_at=NOW()
       WHERE id=$2 AND status='searching'
       RETURNING *`,
      [chosen.id, ride.id, String(OFFER_TIMEOUT_SEC)]
    );
    const assignedRide = upd.rows[0];
    await client.query('COMMIT');

    if (assignedRide?.id && chosen?.driver_tg_id) {
      const pt = signPtToken(chosen.driver_tg_id, 'driver');
      const url = `${APP_BASE_URL}/app/driver/?pt=${encodeURIComponent(pt)}`;
      const msg = `🚖 Yeni sifariş təklifi (#${assignedRide.id})\n` +
        `${assignedRide.pickup_text || 'Pick-up'} → ${assignedRide.drop_text || 'Drop'}\n` +
        `Məsafə: ${Number(assignedRide.distance_km).toFixed(2)} km\n` +
        `Qiymət: ${Number(assignedRide.fare).toFixed(2)} AZN\n` +
        `⏳ ${OFFER_TIMEOUT_SEC} saniyə ərzində qəbul edin (yoxsa başqa sürücüyə keçəcək).`;
      await sendTelegramToRole('driver', chosen.driver_tg_id, msg, {
        ...webAppButton('🚖 Təklifi aç', url)
      });
    }

    return { ride: assignedRide, driver: chosen };
  } catch (e) {
    try{ await client.query('ROLLBACK'); }catch{}
    throw e;
  } finally {
    client.release();
  }
}


async function ensureOfferTables(){
  // piggy-back on dispatch tables
  await ensureDispatchTables();
startOfferExpiryLoop();
}

// Expire offered rides and re-offer to next drivers (best-effort)
let _expiringOffers = false;
async function expireOffersOnce(limit = 10){
  if (_expiringOffers) return;
  _expiringOffers = true;
  try{
    await ensureOfferTables();
    const client = await pool.connect();
    try{
      await client.query('BEGIN');
      const q = await client.query(
        `SELECT id, offered_driver_id
         FROM rides
         WHERE status='searching'
           AND offered_driver_id IS NOT NULL
           AND offer_expires_at IS NOT NULL
           AND offer_expires_at < NOW()
         ORDER BY offer_expires_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
      );
      const rows = q.rows || [];
      for (const r of rows){
        await client.query(
          `INSERT INTO ride_offer_attempts(ride_id, driver_id, decision) VALUES ($1,$2,'timeout')`,
          [r.id, r.offered_driver_id]
        ).catch(()=>{});
        await client.query(
          `UPDATE rides SET offered_driver_id=NULL, offer_expires_at=NULL, updated_at=NOW()
           WHERE id=$1`,
          [r.id]
        );
      }
      await client.query('COMMIT');
      for (const r of rows){
        try{ await autoAssignRide(Number(r.id)); }catch(_){}
      }
    }catch(e){
      try{ await client.query('ROLLBACK'); }catch{}
    }finally{
      client.release();
    }
  } finally {
    _expiringOffers = false;
  }
}

function startOfferExpiryLoop(){
  setInterval(()=>{ expireOffersOnce(10).catch(()=>{}); }, 5000);
}

function getDriverToken(req){
  return String(req.headers['x-driver-token'] || '').trim();
}

async function requireDriverSession(req, res, next){
  try{
    await ensureDriverAuthTables();
    const token = getDriverToken(req);
    if (!token) return res.status(401).json({ ok:false, error:'need_login' });

    const user = await upsertUser(req.tgUser, 'driver');
    const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
    const driver = dQ.rows[0];
    if (!driver) return res.status(400).json({ ok:false, error:'not_registered' });

    const sQ = await pool.query(
      `SELECT * FROM driver_sessions 
       WHERE token=$1 AND driver_id=$2 AND revoked_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [token, driver.id]
    );
    if (!sQ.rows[0]) return res.status(401).json({ ok:false, error:'need_login' });

    req.driver = driver;
    req.driverSession = sQ.rows[0];
    return next();
  }catch(e){
    console.error('requireDriverSession', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

async function createDriverSession(driver_id){
  await ensureDriverAuthTables();
  const token = crypto.randomBytes(24).toString('hex');
  const q = await pool.query(
    `INSERT INTO driver_sessions (driver_id, token, expires_at)
     VALUES ($1,$2, NOW() + ($3 || ' days')::interval)
     RETURNING token, expires_at`,
    [driver_id, token, String(DRIVER_SESSION_DAYS)]
  );
  return q.rows[0];
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
  let ride = rideQ.rows[0];
  // Auto-assign to an eligible online driver (best-effort; keeps "searching" if none)
  try{
    await expireOffersOnce(10).catch(()=>{});
    const assigned = await autoAssignRide(ride.id);
    if (assigned?.ride) ride = assigned.ride;
  }catch(e){
    console.error('autoAssignRide failed (non-fatal):', e?.message || e);
  }
  res.json({ ok: true, ride });
});

// passenger: check ride status
app.post('/api/passenger/cancel_ride', requireTelegram('passenger'), async (req, res) => {
  try {
    const passenger_tg_id = String(req.tgUser.id);
    const ride_id = Number(req.body.ride_id);
    if (!ride_id) return res.status(400).json({ ok: false, error: 'ride_id_required' });

    const ride = await db.oneOrNone('SELECT * FROM rides WHERE id=$1 AND passenger_tg_id=$2', [ride_id, passenger_tg_id]);
    if (!ride) return res.status(404).json({ ok: false, error: 'ride_not_found' });

    if (!['searching','assigned'].includes(ride.status)) {
      return res.status(400).json({ ok: false, error: 'cannot_cancel', status: ride.status });
    }

    await db.none("UPDATE rides SET status='cancelled', cancelled_at=NOW() WHERE id=$1", [ride_id]);

    if (ride.driver_tg_id) {
      try { await sendTelegramToRole('driver', ride.driver_tg_id, `❌ Sifariş ləğv edildi (#${ride_id}).`); } catch (e) {}
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
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
    // Important: even if some part fails (docs insert, notification etc.),
    // we should still return a JSON response and not break the UX.
    try{
      const body = req.body || {};
      const car_year = Number(body.car_year);
      const car_color = String(body.car_color || '').trim();
      const allowedColors = new Set(['ağ','qara','qırmızı','boz','mavi','sarı','yaşıl']);

      if (!Number.isFinite(car_year) || car_year < 2010) return res.status(400).json({ ok: false, error: 'car_year_min_2010' });
      if (!allowedColors.has(car_color)) return res.status(400).json({ ok: false, error: 'bad_color' });

      const user = await upsertUser(req.tgUser, 'driver');

      // create/update driver row
      const drvQ = await pool.query(
        `INSERT INTO drivers (user_id, phone, car_make, car_model, car_year, car_color, plate)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id) DO UPDATE SET phone=EXCLUDED.phone, car_make=EXCLUDED.car_make, car_model=EXCLUDED.car_model, car_year=EXCLUDED.car_year, car_color=EXCLUDED.car_color, plate=EXCLUDED.plate
         RETURNING *`,
        [user.id, body.phone || null, body.car_make || null, body.car_model || null, car_year, car_color, body.plate || null]
      );
      const driver = drvQ.rows[0];

      // documents are best-effort
      try{
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
      }catch(docErr){
        console.error('driver docs insert failed (non-fatal):', docErr);
      }

      // notify driver that the registration was received (non-fatal)
      if (driverBot) {
        try{
          const pt = signPtToken(req.tgUser.id, 'driver');
          const url = `${APP_BASE_URL}/app/driver/?pt=${encodeURIComponent(pt)}`;
          await driverBot.telegram.sendMessage(Number(req.tgUser.id),
            `✅ Qeydiyyat qəbul olundu.\nStatus: pending (admin təsdiqi gözlənilir).\n\nSürücü panelinə daxil olun:`,
            {
              ...webAppButton('🚖 Sürücü paneli', url),
              disable_web_page_preview: true,
              disable_notification: false
            }
          );
        }catch(notifyErr){}
      }

      return res.json({ ok: true, driver });
    }catch(e){
      console.error('driver register failed:', e);
      return res.status(500).json({ ok:false, error:'server_error' });
    }
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


// driver: set password (after registration)
app.post('/api/driver/set_password', requireTelegram('driver'), async (req, res) => {
  try{
    await ensureDriverAuthTables();
    const { password } = req.body || {};
    if (!password || String(password).length < 4) return res.status(400).json({ ok:false, error:'pass_too_short' });

    const user = await upsertUser(req.tgUser, 'driver');
    const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
    const driver = dQ.rows[0];
    if (!driver) return res.status(400).json({ ok:false, error:'not_registered' });

    const hash = await bcrypt.hash(String(password), 10);
    await pool.query(
      `INSERT INTO driver_credentials (driver_id, password_hash)
       VALUES ($1,$2)
       ON CONFLICT (driver_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, updated_at=NOW()`,
      [driver.id, hash]
    );
    return res.json({ ok:true });
  }catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// driver: login -> returns session token
app.post('/api/driver/login', requireTelegram('driver'), async (req, res) => {
  try{
    await ensureDriverAuthTables();
    const { phone, password } = req.body || {};
    if (!password) return res.status(400).json({ ok:false, error:'missing_password' });

    const user = await upsertUser(req.tgUser, 'driver');
    const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
    const driver = dQ.rows[0];
    if (!driver) return res.status(400).json({ ok:false, error:'not_registered' });

    if (phone && driver.phone && String(phone).trim() !== String(driver.phone).trim()){
      return res.status(403).json({ ok:false, error:'phone_mismatch' });
    }

    const cQ = await pool.query(`SELECT * FROM driver_credentials WHERE driver_id=$1`, [driver.id]);
    const cred = cQ.rows[0];
    if (!cred) return res.status(403).json({ ok:false, error:'no_password_set' });

    const ok = await bcrypt.compare(String(password), String(cred.password_hash));
    if (!ok) return res.status(403).json({ ok:false, error:'bad_password' });

    const sess = await createDriverSession(driver.id);
    await pool.query(`UPDATE drivers SET last_login_at=NOW() WHERE id=$1`, [driver.id]).catch(()=>{});
    return res.json({ ok:true, token: sess.token, expires_at: sess.expires_at, status: driver.status });
  }catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// driver: session me (validate token)
app.get('/api/driver/session_me', requireTelegram('driver'), requireDriverSession, async (req, res) => {
  return res.json({ ok:true, driver: req.driver, session: { expires_at: req.driverSession.expires_at }});
});

// driver: set online/offline (if drivers.is_online exists)
app.post('/api/driver/set_online', requireTelegram('driver'), requireDriverSession, async (req, res) => {
  const { online, lat, lon } = req.body || {};
  const want = !!online;
  const hasCols = await driversHaveOnlineCols();
  if (!hasCols) return res.json({ ok:true, applied:false, online: want });

  await pool.query('BEGIN');
  try{
    await pool.query('SAVEPOINT sp_online');
    try{
      // Optional location update (used for nearest dispatch). Only applied if columns exist.
      const hasLoc = await driversHaveLocationCols();
      if (hasLoc && typeof lat === 'number' && typeof lon === 'number') {
        await pool.query(
          `UPDATE drivers SET is_online=$1, online_updated_at=NOW(), last_lat=$3, last_lon=$4 WHERE id=$2`,
          [want, req.driver.id, lat, lon]
        );
      } else {
        await pool.query(
          `UPDATE drivers SET is_online=$1, online_updated_at=NOW() WHERE id=$2`,
          [want, req.driver.id]
        );
      }
    }catch(e1){
      // fallback if online_updated_at column is missing
      await pool.query('ROLLBACK TO SAVEPOINT sp_online');
      await pool.query(
        `UPDATE drivers SET is_online=$1 WHERE id=$2`,
        [want, req.driver.id]
      );
    }
    await pool.query('COMMIT');

    await expireOffersOnce(10).catch(()=>{});

    // If driver just went online, try to auto-assign the oldest searching ride (best-effort)
    if (want) {
      try{
        const q = await pool.query(`SELECT id FROM rides WHERE status='searching' ORDER BY id ASC LIMIT 1`);
        if (q.rows[0]) await autoAssignRide(Number(q.rows[0].id));
      }catch(_){ }
    }

    return res.json({ ok:true, applied:true, online: want });
  }catch(e){
    // If columns are missing in this DB, avoid aborting the transaction.
    try{ await pool.query('ROLLBACK TO SAVEPOINT sp_online'); }catch{}
    try{ await pool.query('COMMIT'); }catch{}
    console.error('set_online failed', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// driver: update last known location (GPS ping)
// Used for "nearest rides" sorting and (optionally) nearest dispatch.
app.post('/api/driver/location', requireTelegram('driver'), requireDriverSession, async (req, res) => {
  const { lat, lon, accuracy } = req.body || {};
  const hasLoc = await driversHaveLocationCols();
  if (!hasLoc) return res.json({ ok:true, applied:false });
  if (typeof lat !== 'number' || typeof lon !== 'number') return res.status(400).json({ ok:false, error:'bad_location' });

  await ensureDispatchTables();

  // best-effort: do not break request if optional columns don't exist yet
  await pool.query('BEGIN');
  try{
    await pool.query('SAVEPOINT sp_loc');
    try{
      await pool.query(
        `UPDATE drivers
         SET last_lat=$2, last_lon=$3, last_loc_at=NOW(), last_loc_accuracy=$4
         WHERE id=$1`,
        [req.driver.id, lat, lon, (typeof accuracy === 'number' ? accuracy : null)]
      );
    }catch(e1){
      await pool.query('ROLLBACK TO SAVEPOINT sp_loc');
      await pool.query(
        `UPDATE drivers
         SET last_lat=$2, last_lon=$3
         WHERE id=$1`,
        [req.driver.id, lat, lon]
      );
    }
    await pool.query('COMMIT');
    return res.json({ ok:true, applied:true });
  }catch(e){
    try{ await pool.query('ROLLBACK TO SAVEPOINT sp_loc'); }catch{}
    try{ await pool.query('COMMIT'); }catch{}
    console.error('driver/location failed', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// driver: list nearest open rides (requires last_lat/last_lon)
app.get('/api/driver/nearby_rides', requireTelegram('driver'), requireDriverSession, async (req, res) => {
  // Query params:
  // - radius_km: 1/3/5 ... (default 3)
  // - only_offers: 1 => show only offers addressed to this driver (and not expired)
  // - force: 1 => allow one-time search even if driver is offline
  const radiusKm = Math.max(0.1, Math.min(50, Number(req.query.radius_km || 3)));
  const onlyOffers = String(req.query.only_offers || '') === '1';
  const force = String(req.query.force || '') === '1';

  const hasCols = await driversHaveOnlineCols();
  if (hasCols) {
    const dQ = await pool.query(`SELECT is_online, last_lat, last_lon, last_loc_at FROM drivers WHERE id=$1`, [req.driver.id]);
    const row = dQ.rows[0];

    const isOnline = !!row?.is_online;
    if (!isOnline && !force) return res.json({ ok:true, rides: [], offline:true });

    if (row?.last_lat === null || row?.last_lon === null) {
      return res.json({ ok:true, rides: [], note:'no_location', offline: !isOnline });
    }

    const driverLat = Number(row.last_lat);
    const driverLon = Number(row.last_lon);

    let q;
    if (onlyOffers) {
      q = await pool.query(
        `SELECT id, pickup_lat, pickup_lon, pickup_text, drop_text, drop_lat, drop_lon, distance_km, fare, commission, created_at, offer_expires_at
         FROM rides
         WHERE status='searching'
           AND offered_driver_id = $1
           AND offer_expires_at IS NOT NULL
           AND offer_expires_at > NOW()
         ORDER BY offer_expires_at ASC
         LIMIT 200`,
        [req.driver.id]
      );
    } else {
      q = await pool.query(
        `SELECT id, pickup_lat, pickup_lon, pickup_text, drop_text, drop_lat, drop_lon, distance_km, fare, commission, created_at
         FROM rides
         WHERE status='searching'
           AND (offered_driver_id IS NULL OR offered_driver_id = $1)
         ORDER BY id DESC
         LIMIT 200`,
        [req.driver.id]
      );
    }

    const rides = (q.rows||[])
      .map(r => {
        const kmToPickup = haversineKm(driverLat, driverLon, Number(r.pickup_lat), Number(r.pickup_lon));
        return { ...r, km_to_pickup: Math.round(kmToPickup*100)/100 };
      })
      .filter(r => (Number(r.km_to_pickup) <= radiusKm))
      .sort((a,b) => a.km_to_pickup - b.km_to_pickup)
      .slice(0, 15);

    return res.json({
      ok:true,
      rides,
      radius_km: radiusKm,
      only_offers: onlyOffers,
      offline: !isOnline,
      driver_location: { lat: driverLat, lon: driverLon }
    });
  }

  // If DB doesn't have online cols, still attempt based on last_lat/last_lon.
  const dQ = await pool.query(`SELECT last_lat, last_lon FROM drivers WHERE id=$1`, [req.driver.id]);
  const row = dQ.rows[0];
  if (!row || row.last_lat === null || row.last_lon === null) return res.json({ ok:true, rides: [], note:'no_location' });
  const driverLat = Number(row.last_lat);
  const driverLon = Number(row.last_lon);

  let q;
  if (onlyOffers) {
    q = await pool.query(
      `SELECT id, pickup_lat, pickup_lon, pickup_text, drop_text, drop_lat, drop_lon, distance_km, fare, commission, created_at, offer_expires_at
       FROM rides
       WHERE status='searching'
         AND offered_driver_id = $1
         AND offer_expires_at IS NOT NULL
         AND offer_expires_at > NOW()
       ORDER BY offer_expires_at ASC
       LIMIT 200`,
      [req.driver.id]
    );
  } else {
    q = await pool.query(
      `SELECT id, pickup_lat, pickup_lon, pickup_text, drop_text, drop_lat, drop_lon, distance_km, fare, commission, created_at
       FROM rides
       WHERE status='searching'
         AND (offered_driver_id IS NULL OR offered_driver_id = $1)
       ORDER BY id DESC
       LIMIT 200`,
      [req.driver.id]
    );
  }

  const rides = (q.rows||[])
    .map(r => {
      const kmToPickup = haversineKm(driverLat, driverLon, Number(r.pickup_lat), Number(r.pickup_lon));
      return { ...r, km_to_pickup: Math.round(kmToPickup*100)/100 };
    })
    .filter(r => (Number(r.km_to_pickup) <= radiusKm))
    .sort((a,b) => a.km_to_pickup - b.km_to_pickup)
    .slice(0, 15);

  return res.json({ ok:true, rides, radius_km: radiusKm, only_offers: onlyOffers, driver_location: { lat: driverLat, lon: driverLon } });
});

// driver: logout (revoke current token)
app.post('/api/driver/logout', requireTelegram('driver'), async (req, res) => {
  try{
    const token = getDriverToken(req);
    if (token) await pool.query(`UPDATE driver_sessions SET revoked_at=NOW() WHERE token=$1`, [token]);
    return res.json({ ok:true });
  }catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// driver: list searching rides (simple)
app.get('/api/driver/open_rides', requireTelegram('driver'), requireDriverSession, async (req, res) => {
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  if (!driver) return res.status(400).json({ ok: false, error: 'not_registered' });
  if (driver.status !== 'approved') return res.json({ ok: true, rides: [], note: 'not_approved' });
  if (Number(driver.balance) <= DRIVER_BLOCK_AT) return res.json({ ok: true, rides: [], note: 'balance_blocked' });

  // If online/offline columns exist, show rides only when online
  await expireOffersOnce(10).catch(()=>{});

  if (await driversHaveOnlineCols()){
    if (!driver.is_online) return res.json({ ok:true, rides: [], offline:true });
  }

  const offersQ = await pool.query(
    `SELECT * FROM rides
     WHERE status='searching'
       AND offered_driver_id=$1
       AND offer_expires_at IS NOT NULL
       AND offer_expires_at > NOW()
     ORDER BY offer_expires_at ASC LIMIT 5`,
    [driver.id]
  ).catch(()=>({rows:[] }));

  const q = await pool.query(
    `SELECT * FROM rides
     WHERE status='searching'
       AND (offered_driver_id IS NULL OR offer_expires_at IS NULL OR offer_expires_at < NOW())
     ORDER BY id DESC LIMIT 10`
  );
  res.json({ ok: true, offers: offersQ.rows||[], rides: q.rows });
});

// driver: accept ride
app.post('/api/driver/accept', requireTelegram('driver'), requireDriverSession, async (req, res) => {
  const { ride_id } = req.body || {};
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  if (!driver) return res.status(400).json({ ok: false, error: 'not_registered' });
  if (driver.status !== 'approved') return res.status(403).json({ ok: false, error: 'not_approved' });
  if (Number(driver.balance) <= DRIVER_BLOCK_AT) return res.status(403).json({ ok: false, error: 'balance_blocked' });

  const rideQ = await pool.query(
    `UPDATE rides SET offered_driver_id=$1, offer_expires_at=NOW() + ($3 || ' seconds')::interval, updated_at=NOW()
     WHERE id=$2 AND status='searching'
     RETURNING *`,
    [driver.id, ride_id]
  );
  if (!rideQ.rows[0]) return res.status(409).json({ ok: false, error: 'ride_not_available' });
  await pool.query(`INSERT INTO ride_offer_attempts(ride_id, driver_id, decision) VALUES ($1,$2,'accept')`, [ride_id, driver.id]).catch(()=>{});
  res.json({ ok: true, ride: rideQ.rows[0] });
});


// driver: reject offered ride (or free up an active offer) and re-offer to someone else
app.post('/api/driver/reject', requireTelegram('driver'), requireDriverSession, async (req, res) => {
  const { ride_id } = req.body || {};
  const user = await upsertUser(req.tgUser, 'driver');
  const dQ = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
  const driver = dQ.rows[0];
  if (!driver) return res.status(400).json({ ok: false, error: 'not_registered' });

  const q = await pool.query(
    `UPDATE rides
     SET offered_driver_id=NULL, offer_expires_at=NULL, updated_at=NOW()
     WHERE id=$1 AND status='searching' AND offered_driver_id=$2
     RETURNING *`,
    [ride_id, driver.id]
  );
  if (!q.rows[0]) return res.status(409).json({ ok:false, error:'not_offered_to_you' });

  await pool.query(`INSERT INTO ride_offer_attempts(ride_id, driver_id, decision) VALUES ($1,$2,'reject')`, [ride_id, driver.id]).catch(()=>{});

  try{ await autoAssignRide(Number(ride_id)); }catch(_){}

  return res.json({ ok:true });
});

// driver: start
app.post('/api/driver/start', requireTelegram('driver'), requireDriverSession, async (req, res) => {
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
app.post('/api/driver/complete', requireTelegram('driver'), requireDriverSession, async (req, res) => {
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
app.post('/api/driver/topup_request', requireTelegram('driver'), requireDriverSession, async (req, res) => {
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

  // Notify driver on approval (best-effort; never breaks admin flow)
  if (status === 'approved' && driverBot && q.rows[0]) {
    try {
      const infoQ = await pool.query(
        `SELECT u.tg_id, u.first_name, u.username
         FROM drivers d
         JOIN users u ON u.id=d.user_id
         WHERE d.id=$1`,
        [driver_id]
      );
      const u = infoQ.rows[0];
      if (u && u.tg_id) {
        const pt = signPtToken(Number(u.tg_id), 'driver');
        const url = `${APP_BASE_URL}/app/driver/?pt=${encodeURIComponent(pt)}`;
        const name = u.first_name ? `, ${u.first_name}` : '';
        const text = `✅ Təsdiqləndiniz${name}!\n\nArtıq PayTaksi sürücü panelinə daxil olub login edə bilərsiniz.`;
        await driverBot.telegram.sendMessage(Number(u.tg_id), text, {
          ...webAppButton('🚖 Sürücü paneli', url),
          disable_web_page_preview: true,
          disable_notification: false
        });
      }
    } catch (e) {
      console.error('driver approval notify failed', e);
    }
  }

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
// Additive: ensure optional tables/columns for dispatch are present.
await ensureDispatchTables();
startOfferExpiryLoop();

app.listen(PORT, () => {
  console.log(`PayTaksi server listening on :${PORT}`);
  console.log(`Webhook secret path: /webhook/${WEBHOOK_SECRET}/...`);
});
