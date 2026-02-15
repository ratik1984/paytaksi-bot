-- PayTaksi Bolt-style: passenger nearby drivers + safe driver location columns
-- Additive only. Safe to run multiple times.

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_loc_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_loc_accuracy DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE;

-- Helpful indexes for live driver lookup
CREATE INDEX IF NOT EXISTS idx_drivers_last_loc_at ON drivers(last_loc_at);
CREATE INDEX IF NOT EXISTS idx_drivers_is_online ON drivers(is_online);
CREATE INDEX IF NOT EXISTS idx_drivers_last_lat_lon ON drivers(last_lat, last_lon);
