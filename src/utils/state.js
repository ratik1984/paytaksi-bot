import { q } from '../db.js';

export async function stateGet(key, defVal = null) {
  const r = await q('SELECT value FROM bot_state WHERE key=$1', [key]);
  return r.rows[0]?.value ?? defVal;
}

export async function stateSet(key, value) {
  await q(
    `INSERT INTO bot_state(key,value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [key, value]
  );
}

export async function stateDel(key) {
  await q('DELETE FROM bot_state WHERE key=$1', [key]);
}
