-- Optional performance indexes for ride_messages archive/statistics
-- Safe to run multiple times.

CREATE INDEX IF NOT EXISTS idx_ride_messages_created_at ON ride_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_ride_messages_ride_id_created_at ON ride_messages (ride_id, created_at);
