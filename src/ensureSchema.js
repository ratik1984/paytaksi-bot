import { pool } from './db.js';

export async function ensureSchema() {
  // Create minimal tables needed for PRO flow. Safe to run multiple times.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_locations (
        driver_tg_id BIGINT PRIMARY KEY,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        heading DOUBLE PRECISION,
        speed DOUBLE PRECISION,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        passenger_tg_id BIGINT NOT NULL,
        pickup_lat DOUBLE PRECISION NOT NULL,
        pickup_lng DOUBLE PRECISION NOT NULL,
        pickup_text TEXT,
        dropoff_lat DOUBLE PRECISION NOT NULL,
        dropoff_lng DOUBLE PRECISION NOT NULL,
        dropoff_text TEXT,
        est_distance_km DOUBLE PRECISION,
        est_duration_min DOUBLE PRECISION,
        est_price DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'searching',
        assigned_driver_tg_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS rides_passenger_idx ON rides(passenger_tg_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS rides_status_idx ON rides(status);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ride_offers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        driver_tg_id BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(ride_id, driver_tg_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS ride_offers_ride_idx ON ride_offers(ride_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ride_offers_driver_idx ON ride_offers(driver_tg_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_free_rides (
        passenger_tg_id BIGINT PRIMARY KEY,
        remaining INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ ensureSchema failed:', e);
    return { ok: false, error: 'schema_init_failed' };
  } finally {
    client.release();
  }
}
