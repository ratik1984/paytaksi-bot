import pg from 'pg';
import { cfg } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.nodeEnv === 'production' ? { rejectUnauthorized: false } : undefined,
});

export async function q(text, params) {
  const res = await pool.query(text, params);
  return res;
}
