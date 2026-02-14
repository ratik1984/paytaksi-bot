-- PayTaksi MVP schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('passenger','driver')),
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drivers (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT,
  car_make TEXT,
  car_model TEXT,
  car_year INT NOT NULL CHECK (car_year >= 2010),
  car_color TEXT NOT NULL CHECK (car_color IN ('ağ','qara','qırmızı','boz','mavi','sarı','yaşıl')),
  plate TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','blocked')),
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS driver_documents (
  id BIGSERIAL PRIMARY KEY,
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('id_front','id_back','dl_front','dl_back','tp_front','tp_back')),
  file_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(driver_id, doc_type)
);

CREATE TABLE IF NOT EXISTS topup_requests (
  id BIGSERIAL PRIMARY KEY,
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('kart-to-kart','m10')),
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  note TEXT
);

CREATE TABLE IF NOT EXISTS rides (
  id BIGSERIAL PRIMARY KEY,
  passenger_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_id BIGINT REFERENCES drivers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'searching' CHECK (status IN ('searching','assigned','started','completed','cancelled')),
  pickup_lat DOUBLE PRECISION NOT NULL,
  pickup_lon DOUBLE PRECISION NOT NULL,
  pickup_text TEXT,
  drop_lat DOUBLE PRECISION NOT NULL,
  drop_lon DOUBLE PRECISION NOT NULL,
  drop_text TEXT,
  distance_km DOUBLE PRECISION NOT NULL,
  fare NUMERIC(12,2) NOT NULL,
  commission NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT,
  cancelled_reason TEXT
);

CREATE INDEX IF NOT EXISTS rides_status_idx ON rides(status);
