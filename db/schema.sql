CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  passenger_tg BIGINT NOT NULL,
  driver_tg BIGINT,
  from_title TEXT NOT NULL,
  from_lat DOUBLE PRECISION,
  from_lng DOUBLE PRECISION,
  to_title TEXT NOT NULL,
  to_lat DOUBLE PRECISION,
  to_lng DOUBLE PRECISION,
  distance_km DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_azn DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission_azn DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'searching', -- searching | accepted | in_progress | completed | cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rides_passenger_status_idx ON rides(passenger_tg, status);
CREATE INDEX IF NOT EXISTS rides_driver_status_idx ON rides(driver_tg, status);

CREATE TABLE IF NOT EXISTS ride_chat_messages (
  id SERIAL PRIMARY KEY,
  ride_id INT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL, -- passenger | driver
  sender_tg BIGINT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_users (
  tg_id BIGINT PRIMARY KEY,
  role TEXT NOT NULL, -- passenger | driver | admin
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

