-- Postgres schema (optional, auto-created by server at runtime)
CREATE TABLE IF NOT EXISTS tg_users (
  tg_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rides (
  id BIGSERIAL PRIMARY KEY,
  passenger_tg_id TEXT NOT NULL REFERENCES tg_users(tg_id) ON DELETE CASCADE,
  from_lat DOUBLE PRECISION NOT NULL,
  from_lng DOUBLE PRECISION NOT NULL,
  to_lat DOUBLE PRECISION NOT NULL,
  to_lng DOUBLE PRECISION NOT NULL,
  from_text TEXT,
  to_text TEXT,
  status TEXT NOT NULL DEFAULT 'NEW',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rides_passenger_idx ON rides(passenger_tg_id);
CREATE INDEX IF NOT EXISTS rides_status_idx ON rides(status);
