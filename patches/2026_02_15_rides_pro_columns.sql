-- PayTaksi PRO hotfix: ensure rides table has required columns used by server.js
-- Safe to run multiple times.

ALTER TABLE IF EXISTS rides
  ADD COLUMN IF NOT EXISTS distance_km NUMERIC,
  ADD COLUMN IF NOT EXISTS fare NUMERIC,
  ADD COLUMN IF NOT EXISTS commission NUMERIC,
  ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT FALSE;

-- Optional helpful indexes (safe)
CREATE INDEX IF NOT EXISTS idx_rides_status_created_at ON rides(status, created_at);
CREATE INDEX IF NOT EXISTS idx_rides_passenger_created_at ON rides(passenger_user_id, created_at);
