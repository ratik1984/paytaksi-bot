-- PayTaksi minimal schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS passengers (
  id SERIAL PRIMARY KEY,
  tg_user_id BIGINT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  tg_user_id BIGINT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  car_brand TEXT,
  car_model TEXT,
  car_plate TEXT,
  car_photo_file_id TEXT,
  doc_driver_license_file_id TEXT,
  doc_id_front_file_id TEXT,
  doc_id_back_file_id TEXT,
  doc_car_passport_front_file_id TEXT,
  doc_car_passport_back_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/active/blocked
  online BOOLEAN NOT NULL DEFAULT FALSE,
  busy BOOLEAN NOT NULL DEFAULT FALSE,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_lat DOUBLE PRECISION,
  last_lon DOUBLE PRECISION,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  passenger_id INT REFERENCES passengers(id),
  driver_id INT REFERENCES drivers(id),
  status TEXT NOT NULL DEFAULT 'requested', -- requested/accepted/arrived/started/finished/cancelled
  pickup_lat DOUBLE PRECISION,
  pickup_lon DOUBLE PRECISION,
  drop_lat DOUBLE PRECISION,
  drop_lon DOUBLE PRECISION,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  distance_km NUMERIC(10,3),
  fare_azn NUMERIC(12,2),
  commission_azn NUMERIC(12,2)
);

CREATE TABLE IF NOT EXISTS topup_requests (
  id SERIAL PRIMARY KEY,
  driver_id INT REFERENCES drivers(id),
  amount_azn NUMERIC(12,2) NOT NULL,
  method TEXT NOT NULL, -- card_to_card/terminal/m10/other
  receipt_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected
  admin_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS balance_ledger (
  id SERIAL PRIMARY KEY,
  driver_id INT REFERENCES drivers(id),
  kind TEXT NOT NULL, -- topup/commission/manual
  amount_azn NUMERIC(12,2) NOT NULL,
  ref_table TEXT,
  ref_id INT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drivers_online ON drivers(online, busy, status);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topup_requests(status);
