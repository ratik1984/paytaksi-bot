-- PayTaksi: Offer/Reject/Timeout dispatch (additive)

ALTER TABLE rides ADD COLUMN IF NOT EXISTS offered_driver_id BIGINT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_rides_offer_expires ON rides(offer_expires_at);

CREATE TABLE IF NOT EXISTS ride_offer_attempts (
  id BIGSERIAL PRIMARY KEY,
  ride_id BIGINT NOT NULL,
  driver_id BIGINT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('reject','timeout','accept')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_offer_attempts_ride ON ride_offer_attempts(ride_id, driver_id);
