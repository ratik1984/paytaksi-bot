const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function initDb() {
  const sqlPath = path.join(__dirname, '..', 'sql', 'init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
}

module.exports = { initDb };
