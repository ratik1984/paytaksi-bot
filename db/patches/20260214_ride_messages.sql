-- Ride messages (in-app chat between passenger and driver)
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS ride_messages (
  id BIGSERIAL PRIMARY KEY,
  ride_id BIGINT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('passenger','driver')),
  sender_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ride_messages_ride_id_id ON ride_messages (ride_id, id);
