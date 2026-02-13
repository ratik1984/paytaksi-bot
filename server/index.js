import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { verifyTelegramInitData, parseInitData } from "./lib/telegram.js";
import { getPool, ensureSchema } from "./lib/store.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Static WebApp (optional) ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// If you deploy webapp under server/public/webapp, it will serve at /webapp/
app.use("/webapp", express.static(path.join(__dirname, "public", "webapp")));

// ---- Health ----
app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Telegram Verify (secure) ----
// Frontend sends { initData } from Telegram.WebApp.initData
app.post("/api/verify-telegram", async (req, res) => {
  const initData = (req.body && req.body.initData) ? String(req.body.initData) : "";
  const botToken = process.env.BOT_TOKEN;

  if (!initData) return res.status(400).json({ ok: false, error: "initData missing" });
  if (!botToken) return res.status(500).json({ ok: false, error: "BOT_TOKEN not set" });

  const check = verifyTelegramInitData(initData, botToken);
  if (!check.ok) return res.status(401).json({ ok: false, error: "invalid signature" });

  // Extract user
  const data = parseInitData(initData);
  let user = null;
  try { user = JSON.parse(data.user || "null"); } catch { user = null; }
  if (!user?.id) return res.status(400).json({ ok: false, error: "user missing" });

  // Optional: enforce freshness (auth_date within 24h)
  const authDate = Number(data.auth_date || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || (now - authDate) > 86400) {
    return res.status(401).json({ ok: false, error: "auth_date too old" });
  }

  // ---- Auto-register / update user in DB (if DATABASE_URL provided) ----
  const pool = getPool();
  if (pool) {
    await ensureSchema(pool);
    const tgId = String(user.id);
    const username = user.username ? String(user.username) : null;
    const firstName = user.first_name ? String(user.first_name) : null;
    const lastName = user.last_name ? String(user.last_name) : null;

    await pool.query(
      `INSERT INTO tg_users (tg_id, username, first_name, last_name, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tg_id) DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         last_seen_at = NOW()`,
      [tgId, username, firstName, lastName]
    );
  }

  return res.json({ ok: true, user });
});

// ---- Who am I (uses verified initData) ----
app.post("/api/me", async (req, res) => {
  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ ok: false, error: "initData missing" });

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return res.status(500).json({ ok: false, error: "BOT_TOKEN not set" });

  const check = verifyTelegramInitData(String(initData), botToken);
  if (!check.ok) return res.status(401).json({ ok: false, error: "invalid signature" });

  const data = parseInitData(String(initData));
  let user = null;
  try { user = JSON.parse(data.user || "null"); } catch {}
  if (!user?.id) return res.status(400).json({ ok: false, error: "user missing" });

  const pool = getPool();
  if (!pool) {
    return res.json({ ok: true, user, db: "disabled" });
  }

  await ensureSchema(pool);
  const r = await pool.query("SELECT tg_id, username, first_name, last_name, created_at, last_seen_at FROM tg_users WHERE tg_id=$1", [String(user.id)]);
  return res.json({ ok: true, user, profile: r.rows[0] || null });
});

// ---- Create Ride (placeholder - secure) ----
app.post("/api/rides", async (req, res) => {
  const { initData, from_lat, from_lng, to_lat, to_lng, from_text, to_text } = req.body || {};
  if (!initData) return res.status(400).json({ ok: false, error: "initData missing" });

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return res.status(500).json({ ok: false, error: "BOT_TOKEN not set" });

  const check = verifyTelegramInitData(String(initData), botToken);
  if (!check.ok) return res.status(401).json({ ok: false, error: "invalid signature" });

  const data = parseInitData(String(initData));
  let user = null;
  try { user = JSON.parse(data.user || "null"); } catch {}
  if (!user?.id) return res.status(400).json({ ok: false, error: "user missing" });

  // Basic validation
  const fl = Number(from_lat), fg = Number(from_lng), tl = Number(to_lat), tg = Number(to_lng);
  if (![fl, fg, tl, tg].every((n) => Number.isFinite(n))) {
    return res.status(400).json({ ok: false, error: "coords invalid" });
  }

  const pool = getPool();
  if (!pool) {
    // no db mode
    return res.json({ ok: true, ride: { id: "demo", passenger_tg_id: String(user.id) } });
  }

  await ensureSchema(pool);

  const ins = await pool.query(
    `INSERT INTO rides (passenger_tg_id, from_lat, from_lng, to_lat, to_lng, from_text, to_text, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'NEW')
     RETURNING id, passenger_tg_id, status, created_at`,
    [String(user.id), fl, fg, tl, tg, from_text || null, to_text || null]
  );

  return res.json({ ok: true, ride: ins.rows[0] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("PayTaksi API running on port", PORT));
