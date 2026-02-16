const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function initDb() {
  const sqlPath = path.join(__dirname, '..', 'sql', 'init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);

  // --- Schema hardening / best-effort migrations ---
  // Some deployments already have a `drivers` table but with a slightly
  // different column set (e.g. `last_lon` instead of `last_lng`, missing
  // `password_hash`). These ALTERs are safe and idempotent.
  try {
    await pool.query("ALTER TABLE drivers ADD COLUMN IF NOT EXISTS password_hash TEXT");
  } catch (_) {}
  try {
    await pool.query("ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_lng DOUBLE PRECISION");
  } catch (_) {}
  try {
    await pool.query("ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP");
  } catch (_) {}

  // Helpful index (ignore if not allowed)
  try {
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS drivers_phone_uq ON drivers(phone)");
  } catch (_) {}
}

module.exports = { initDb };
