const { Pool } = require('pg');

function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: url, ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined });
}

async function initDb(pool) {
  // Core tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('passenger','driver','admin')),
      first_name TEXT,
      last_name TEXT,
      phone_e164 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS drivers (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','banned')),
      operator TEXT,
      car_make TEXT,
      car_model TEXT,
      car_color TEXT,
      docs_id_front_file_id TEXT,
      docs_id_back_file_id TEXT,
      docs_license_file_id TEXT,
      docs_car_file_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS driver_locations (
      driver_user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      heading DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      is_online BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rides (
      id UUID PRIMARY KEY,
      passenger_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      driver_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('requested','offered','accepted','arrived','started','completed','canceled')),

      pickup_lat DOUBLE PRECISION NOT NULL,
      pickup_lng DOUBLE PRECISION NOT NULL,
      pickup_text TEXT,

      dropoff_lat DOUBLE PRECISION NOT NULL,
      dropoff_lng DOUBLE PRECISION NOT NULL,
      dropoff_text TEXT,

      distance_km DOUBLE PRECISION,
      duration_min DOUBLE PRECISION,

      base_fare NUMERIC(10,2),
      included_km DOUBLE PRECISION,
      per_km NUMERIC(10,2),
      surge_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      total_fare NUMERIC(10,2),
      commission_pct DOUBLE PRECISION NOT NULL DEFAULT 10,
      commission_amount NUMERIC(10,2),
      driver_earnings NUMERIC(10,2),

      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      arrived_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS ride_offers (
      ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
      driver_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('offered','accepted','rejected','expired')),
      offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      responded_at TIMESTAMPTZ,
      PRIMARY KEY (ride_id, driver_user_id)
    );
  `);

  // Defaults (idempotent)
  await upsertSetting(pool, 'base_fare', String(process.env.BASE_FARE ?? '3.50'));
  await upsertSetting(pool, 'included_km', String(process.env.INCLUDED_KM ?? '3'));
  await upsertSetting(pool, 'per_km', String(process.env.PER_KM ?? '0.40'));
  await upsertSetting(pool, 'commission_pct', String(process.env.COMMISSION_PCT ?? '10'));
  await upsertSetting(pool, 'dispatch_radius_km', String(process.env.DISPATCH_RADIUS_KM ?? '2'));
  await upsertSetting(pool, 'dispatch_offer_timeout_sec', String(process.env.DISPATCH_OFFER_TIMEOUT_SEC ?? '15'));
}

async function upsertSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO settings(key,value) VALUES($1,$2)
     ON CONFLICT (key) DO NOTHING`,
    [key, value]
  );
}

async function getSetting(pool, key) {
  const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0]?.value ?? null;
}

module.exports = { getPool, initDb, getSetting };
