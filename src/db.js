import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

function ensureDir(p) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
}

ensureDir(CONFIG.SQLITE_PATH);
export const db = new Database(CONFIG.SQLITE_PATH);
db.pragma("journal_mode = WAL");

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER UNIQUE NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('passenger','driver','admin')),
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    phone TEXT,
    rating REAL DEFAULT 5.0,
    rating_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS driver_profile (
    user_id INTEGER PRIMARY KEY,
    car_brand TEXT,
    car_model TEXT,
    car_color TEXT,
    car_plate TEXT,
    seats INTEGER DEFAULT 4,
    options_json TEXT DEFAULT '{}',
    is_online INTEGER DEFAULT 0,
    last_lat REAL,
    last_lng REAL,
    last_update INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rides (
    id TEXT PRIMARY KEY,
    passenger_user_id INTEGER NOT NULL,
    driver_user_id INTEGER,
    status TEXT NOT NULL CHECK(status IN ('draft','searching','offered','accepted','arrived','started','completed','cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    pickup_text TEXT,
    pickup_lat REAL,
    pickup_lng REAL,

    dropoff_text TEXT,
    dropoff_lat REAL,
    dropoff_lng REAL,

    payment_method TEXT CHECK(payment_method IN ('cash','card')) DEFAULT 'cash',
    price_estimate REAL DEFAULT 0,
    distance_km REAL DEFAULT 0,
    note TEXT,

    passenger_rating INTEGER,
    driver_rating INTEGER
  );

  CREATE TABLE IF NOT EXISTS ride_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ride_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    actor_role TEXT,
    type TEXT NOT NULL,
    payload_json TEXT DEFAULT '{}',
    FOREIGN KEY(ride_id) REFERENCES rides(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_rides_passenger ON rides(passenger_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_driver_online ON driver_profile(is_online);
  `);
}
