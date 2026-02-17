import { q } from '../db.js';

export async function getUserByTgId(tgId) {
  const r = await q('SELECT * FROM users WHERE tg_id=$1 LIMIT 1', [tgId]);
  return r.rows[0] || null;
}

export async function upsertUser({ role, tgId, firstName, lastName, phone }) {
  const r = await q(
    `INSERT INTO users(role,tg_id,first_name,last_name,phone)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tg_id) DO UPDATE SET
       role=EXCLUDED.role,
       first_name=COALESCE(EXCLUDED.first_name, users.first_name),
       last_name=COALESCE(EXCLUDED.last_name, users.last_name),
       phone=COALESCE(EXCLUDED.phone, users.phone)
     RETURNING *`,
    [role, tgId, firstName || null, lastName || null, phone || null]
  );
  return r.rows[0];
}

export async function ensurePassengerProfile(userId) {
  await q('INSERT INTO passenger_profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
}

export async function ensureDriverProfile(userId) {
  await q(
    `INSERT INTO driver_profiles(user_id) VALUES ($1)
     ON CONFLICT DO NOTHING`,
    [userId]
  );
}

export async function getDriverProfile(userId) {
  const r = await q('SELECT * FROM driver_profiles WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}

export async function setDriverBalance(userId, newBalance) {
  await q('UPDATE driver_profiles SET balance_azn=$2, updated_at=NOW() WHERE user_id=$1', [userId, newBalance]);
}

export async function addDriverLedger(userId, amount, reason, meta = null) {
  await q(
    'INSERT INTO driver_balance_ledger(driver_id, amount_azn, reason, meta) VALUES ($1,$2,$3,$4)',
    [userId, amount, reason, meta]
  );
}

export async function bumpDriverBalance(userId, delta, reason, meta = null) {
  const r = await q('SELECT balance_azn FROM driver_profiles WHERE user_id=$1', [userId]);
  const cur = Number(r.rows[0]?.balance_azn || 0);
  const next = Math.round((cur + Number(delta)) * 100) / 100;
  await setDriverBalance(userId, next);
  await addDriverLedger(userId, delta, reason, meta);
  return next;
}
