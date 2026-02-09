import pg from 'pg';
const { Pool } = pg;

export async function initDb() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });

  // quick test
  await pool.query('SELECT 1 as ok');

  return {
    pool,
    query: (text, params) => pool.query(text, params),
  };
}
