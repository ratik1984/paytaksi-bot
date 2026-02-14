import { pool } from '../src/db.js';

async function main() {
  await pool.query('SELECT 1');
  console.log('DB ok. Running schema...');
  const fs = await import('fs');
  const path = await import('path');
  const sql = fs.readFileSync(path.resolve('db/schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema applied.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
