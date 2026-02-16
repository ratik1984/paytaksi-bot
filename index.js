require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// STATIC
app.use(express.static(path.join(__dirname, 'public')));

// ================= DRIVER REGISTER =================
app.post('/api/driver/register', async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      phone,
      password,
      car_make,
      car_model,
      car_year,
      plate
    } = req.body;

    if (!first_name  !phone || !password) {
      return res.status(400).json({ error: "Məlumatlar natamamdır" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    await pool.query(
      INSERT INTO drivers
      (first_name, last_name, phone, password_hash, car_make, car_model, car_year, plate, status, is_approved, is_online)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',false,false)
    , [
      first_name,
      last_name,
      phone,
      password_hash,
      car_make,
      car_model,
      car_year,
      plate
    ]);

    res.json({ success: true });

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= DRIVER DELETE (ADMIN) =================
app.post('/api/admin/delete-driver', async (req, res) => {
  try {
    const { id } = req.body;

    await pool.query("DELETE FROM drivers WHERE id = $1", [id]);

    res.json({ success: true });

  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= SERVER =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("PayTaksi server listening on", PORT);
});
