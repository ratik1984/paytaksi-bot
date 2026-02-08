/**
 * PayTaksi Telegram Bot – LIVE MAP + ETA + HISTORY (ALL-IN-ONE)
 * Additions:
 * 1) Customer gets LIVE driver map link (Google Maps) on accept + periodic refresh on driver location updates
 * 2) ETA using OSRM duration
 * 3) History:
 *    - Customer: /orders
 *    - Driver: /myrides
 *
 * NOTE:
 * - Uses OSRM public router (free)
 * - Live map is a link that always points to driver's LAST location (updates as driver sends location)
 */

const express = require("express");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").filter(Boolean).map(Number);
const OFFER_DRIVERS = Number(process.env.OFFER_DRIVERS || 5);

const db = new Database("paytaksi.sqlite");

const now = () => Math.floor(Date.now() / 1000);
const isAdmin = (id) => ADMIN_IDS.includes(Number(id));

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------- Helpers ----------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function osrmRoute(pLat, pLon, dLat, dLon) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${pLon},${pLat};${dLon},${dLat}?overview=false`;
    const r = await fetch(url);
    const j = await r.json();
    if (j?.routes?.[0]) {
      return {
        km: j.routes[0].distance / 1000,
        sec: j.routes[0].duration,
      };
    }
  } catch {}
  const km = haversineKm(pLat, pLon, dLat, dLon);
  return { km, sec: Math.round((km / 40) * 3600) }; // fallback 40km/h
}

function calcPrice(km) {
  if (km <= 3) return 3.5;
  return +(3.5 + Math.ceil(km - 3) * 0.4).toFixed(2);
}

function gmapsLL(lat, lon) {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

// ---------- DB ----------
db.exec(`
CREATE TABLE IF NOT EXISTS drivers (
  tg_id INTEGER PRIMARY KEY,
  is_approved INTEGER DEFAULT 0,
  is_online INTEGER DEFAULT 0,
  full_name TEXT,
  phone TEXT,
  car TEXT,
  plate TEXT,
  last_lat REAL,
  last_lon REAL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  driver_id INTEGER,
  status TEXT,
  pickup_lat REAL,
  pickup_lon REAL,
  drop_lat REAL,
  drop_lon REAL,
  distance_km REAL,
  price_azn REAL,
  eta_sec INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);
`);

// ---------- Routes ----------
app.get("/", (req, res) => res.send("PayTaksi LIVE running 🚕"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post(`/tg/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const u = req.body;

    // -------- DRIVER LOCATION UPDATE (LIVE MAP REFRESH) --------
    if (u.message && u.message.location) {
      const tgId = u.message.from.id;
      const { latitude, longitude } = u.message.location;

      const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
      if (d) {
        db.prepare(`UPDATE drivers SET last_lat=?, last_lon=?, updated_at=? WHERE tg_id=?`)
          .run(latitude, longitude, now(), tgId);

        // find active order
        const o = db.prepare(
          `SELECT * FROM orders WHERE driver_id=? AND status IN ('accepted','arrived','in_trip') ORDER BY updated_at DESC LIMIT 1`
        ).get(tgId);

        if (o) {
          await tg("sendMessage", {
            chat_id: o.customer_id,
            text: `📍 Sürücünün canlı xəritəsi:\n${gmapsLL(latitude, longitude)}`,
          });
        }
      }
      return res.sendStatus(200);
    }

    // -------- CALLBACKS (accept simplified demo) --------
    if (u.callback_query) {
      const { data, from } = u.callback_query;
      if (data.startsWith("accept:")) {
        const id = Number(data.split(":")[1]);
        const o = db.prepare(`SELECT * FROM orders WHERE id=?`).get(id);
        if (!o) return res.sendStatus(200);

        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(from.id);
        if (!d) return res.sendStatus(200);

        // ETA
        const route = await osrmRoute(d.last_lat, d.last_lon, o.pickup_lat, o.pickup_lon);

        db.prepare(
          `UPDATE orders SET driver_id=?, status='accepted', eta_sec=?, updated_at=? WHERE id=?`
        ).run(from.id, route.sec, now(), id);

        await tg("sendMessage", {
          chat_id: o.customer_id,
          text:
            `🚕 Sürücü tapıldı!\n` +
            `⏱️ ETA: ${Math.ceil(route.sec / 60)} dəq\n` +
            `📍 Canlı xəritə:\n${gmapsLL(d.last_lat, d.last_lon)}`,
        });
      }
      return res.sendStatus(200);
    }

    // -------- HISTORY COMMANDS --------
    if (u.message && u.message.text) {
      const text = u.message.text;
      const tgId = u.message.from.id;

      if (text === "/orders") {
        const rows = db.prepare(
          `SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 20`
        ).all(tgId);

        if (!rows.length) {
          await tg("sendMessage", { chat_id: tgId, text: "Sifariş yoxdur." });
        } else {
          for (const o of rows) {
            await tg("sendMessage", {
              chat_id: tgId,
              text:
                `#${o.id} | ${o.status}\n` +
                `📏 ${Number(o.distance_km || 0).toFixed(2)} km\n` +
                `💰 ${Number(o.price_azn || 0).toFixed(2)} AZN`,
            });
          }
        }
        return res.sendStatus(200);
      }

      if (text === "/myrides") {
        const rows = db.prepare(
          `SELECT * FROM orders WHERE driver_id=? ORDER BY created_at DESC LIMIT 20`
        ).all(tgId);

        if (!rows.length) {
          await tg("sendMessage", { chat_id: tgId, text: "Sürüş yoxdur." });
        } else {
          for (const o of rows) {
            await tg("sendMessage", {
              chat_id: tgId,
              text:
                `#${o.id} | ${o.status}\n` +
                `📏 ${Number(o.distance_km || 0).toFixed(2)} km\n` +
                `💰 ${Number(o.price_azn || 0).toFixed(2)} AZN`,
            });
          }
        }
        return res.sendStatus(200);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("LIVE server on", PORT));
