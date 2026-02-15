-- PayTaksi additive patch: realtime dispatch columns + rating + finance ledger
-- Safe to run multiple times.

-- Drivers online + last known position
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_loc_at TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_loc_accuracy DOUBLE PRECISION;

-- Rides offer timeout columns
ALTER TABLE rides ADD COLUMN IF NOT EXISTS offered_driver_id BIGINT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ;

-- Optional: free ride flag
ALTER TABLE rides ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT FALSE;

-- Driver rating aggregates
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(4,2) NOT NULL DEFAULT 5.0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rating_count INT NOT NULL DEFAULT 0;

-- Ratings table
CREATE TABLE IF NOT EXISTS ride_ratings(
  id BIGSERIAL PRIMARY KEY,
  ride_id BIGINT NOT NULL UNIQUE REFERENCES rides(id) ON DELETE CASCADE,
  passenger_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Driver ledger
CREATE TABLE IF NOT EXISTS driver_ledger(
  id BIGSERIAL PRIMARY KEY,
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  ride_id BIGINT REFERENCES rides(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_ledger_driver_created ON driver_ledger(driver_id, created_at);
