-- Additive: automatic ride dispatch support

-- Driver last known location (optional; used for nearest dispatch)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS idx_drivers_last_latlon ON drivers(last_lat, last_lon);

-- Single-row dispatcher state for round-robin
CREATE TABLE IF NOT EXISTS dispatch_state (
  id INT PRIMARY KEY DEFAULT 1,
  last_driver_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dispatch_state(id,last_driver_id)
VALUES (1,NULL)
ON CONFLICT (id) DO NOTHING;
