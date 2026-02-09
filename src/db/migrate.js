import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined,
});

const sql = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'rider', -- rider | driver | admin
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  phone TEXT,
  rating_avg DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  rating_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  car_brand TEXT NOT NULL,
  car_model TEXT NOT NULL,
  car_color TEXT NOT NULL,
  car_plate TEXT NOT NULL,
  car_year INT NOT NULL,
  docs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by BIGINT NULL REFERENCES users(id),
  reviewed_at TIMESTAMPTZ NULL,
  review_note TEXT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  heading DOUBLE PRECISION NULL,
  speed DOUBLE PRECISION NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rides (
  id BIGSERIAL PRIMARY KEY,
  rider_id BIGINT NOT NULL REFERENCES users(id),
  driver_id BIGINT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'searching', -- searching|assigned|accepted|arriving|in_trip|completed|cancelled
  pickup_lat DOUBLE PRECISION NOT NULL,
  pickup_lng DOUBLE PRECISION NOT NULL,
  pickup_address TEXT NOT NULL,
  drop_lat DOUBLE PRECISION NOT NULL,
  drop_lng DOUBLE PRECISION NOT NULL,
  drop_address TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash', -- cash|card
  fare_est DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ride_events (
  id BIGSERIAL PRIMARY KEY,
  ride_id BIGINT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  actor_user_id BIGINT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_rider ON rides(rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_status ON driver_profiles(status);
`;

async function main() {
  await pool.query(sql);
  console.log('✅ DB migrated');
  await pool.end();
}

main().catch((e) => {
  console.error('❌ Migration failed', e);
  process.exit(1);
});
