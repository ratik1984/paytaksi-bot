-- Additive: driver online/offline toggle fields
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS online_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_drivers_is_online ON drivers(is_online);
