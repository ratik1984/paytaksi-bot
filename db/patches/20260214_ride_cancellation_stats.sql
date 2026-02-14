-- Additive patch: cancellation audit table for admin statistics

CREATE TABLE IF NOT EXISTS ride_cancellations (
  id BIGSERIAL PRIMARY KEY,
  ride_id BIGINT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('passenger','driver','admin')),
  actor_tg_id BIGINT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ride_cancellations_ride_id_idx ON ride_cancellations(ride_id);
CREATE INDEX IF NOT EXISTS ride_cancellations_created_at_idx ON ride_cancellations(created_at);
CREATE INDEX IF NOT EXISTS ride_cancellations_reason_idx ON ride_cancellations(reason);
