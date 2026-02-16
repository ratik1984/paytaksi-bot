const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : (process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false })
});

module.exports = { pool };
