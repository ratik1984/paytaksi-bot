-- PayTaksi PostgreSQL schema (minimal MVP)

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('passenger','driver','admin')),
  tg_id BIGINT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  car_make TEXT,
  car_model TEXT,
  car_plate TEXT,
  car_color TEXT,
  car_photo_file_id TEXT,
  doc_id_front_file_id TEXT,
  doc_id_back_file_id TEXT,
  doc_license_file_id TEXT,
  doc_reg_front_file_id TEXT,
  doc_reg_back_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  balance_azn NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS passenger_profiles (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ride_requests (
  id BIGSERIAL PRIMARY KEY,
  passenger_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'searching' CHECK (status IN ('searching','matched','cancelled','expired')),
  pickup_lat DOUBLE PRECISION,
  pickup_lng DOUBLE PRECISION,
  pickup_text TEXT,
  dest_lat DOUBLE PRECISION,
  dest_lng DOUBLE PRECISION,
  dest_text TEXT,
  distance_km DOUBLE PRECISION,
  fare_azn NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rides (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT UNIQUE REFERENCES ride_requests(id) ON DELETE SET NULL,
  passenger_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','arrived','started','completed','cancelled')),
  pickup_lat DOUBLE PRECISION,
  pickup_lng DOUBLE PRECISION,
  pickup_text TEXT,
  dest_lat DOUBLE PRECISION,
  dest_lng DOUBLE PRECISION,
  dest_text TEXT,
  distance_km DOUBLE PRECISION,
  fare_azn NUMERIC(12,2),
  commission_azn NUMERIC(12,2),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS driver_balance_ledger (
  id BIGSERIAL PRIMARY KEY,
  driver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_azn NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS topup_requests (
  id BIGSERIAL PRIMARY KEY,
  driver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('card2card','terminal','m10')),
  amount_azn NUMERIC(12,2) NOT NULL,
  receipt_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_rr_status ON ride_requests(status);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_topup_status ON topup_requests(status);
