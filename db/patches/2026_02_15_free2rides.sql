-- PayTaksi: Promo free rides per day (default 2)
-- Run on Render PostgreSQL.

ALTER TABLE rides ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS promo_free_rides (
  passenger_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  promo_date DATE NOT NULL,
  used_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (passenger_user_id, promo_date)
);

CREATE INDEX IF NOT EXISTS idx_promo_free_rides_date ON promo_free_rides(promo_date);
