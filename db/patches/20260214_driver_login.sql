-- Driver login/session support (additive)
-- Creates driver_credentials + driver_sessions, adds optional last_login_at
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS driver_credentials (
  driver_id BIGINT PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS driver_sessions (
  id BIGSERIAL PRIMARY KEY,
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_driver_sessions_driver_id ON driver_sessions(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_sessions_token ON driver_sessions(token);

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
