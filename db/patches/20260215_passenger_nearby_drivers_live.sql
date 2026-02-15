-- PayTaksi Bolt-style live drivers (passenger map) - additive patch
-- Adds location + online columns to drivers table (safe if already exists)

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_loc_at TIMESTAMPTZ;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_online_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_drivers_last_loc_at ON drivers(last_loc_at);
CREATE INDEX IF NOT EXISTS idx_drivers_is_online ON drivers(is_online);

-- NOTE:
-- Driver location is updated by existing endpoint /api/driver/location in the app.
-- Passenger map reads drivers via new endpoint /api/passenger/nearby_drivers (radius default 3km).
