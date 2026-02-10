import pg from 'pg';

const { Pool } = pg;

export function makePool() {
  const ssl = process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined;

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl
  });
}
