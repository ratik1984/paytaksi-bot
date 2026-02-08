const express = require("express");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// ---- Telegram helper (Node 22 built-in fetch) ----
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---- DB (SQLite file in project dir) ----
const db = new Database("paytaksi.sqlite");

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  role TEXT DEFAULT 'customer',
  lang TEXT DEFAULT 'az',
  created_at INTEGER
);

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
  drop_text TEXT,
  distance_km REAL,
  price_azn REAL,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  tg_id INTEGER PRIMARY KEY,
  step TEXT,
  tmp_pickup_lat REAL,
  tmp_pickup_lon REAL,
  tmp_drop_text TEXT,
  updated_at INTEGER
);
`);

const now = () => Math.floor(Date.now() / 1000);

function upsertUser(tgId) {
  db.prepare(
    `INSERT INTO users(tg_id, created_at) VALUES(?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET tg_id=excluded.tg_id`
  ).run(tgId, now());
}

function setStep(tgId, step, extra = {}) {
  const row = db.prepare(`SELECT tg_id FROM sessions WHERE tg_id=?`).get(tgId);
  if (!row) {
    db.prepare(
      `INSERT INTO sessions(tg_id, step, tmp_pickup_lat, tmp_pickup_lon, tmp_drop_text, updated_at)
       VALUES(?,?,?,?,?,?)`
    ).run(
      tgId,
      step,
      extra.tmp_pickup_lat ?? null,
      extra.tmp_pickup_lon ?? null,
      extra.tmp_drop_text ?? null,
      now()
    );
  } else {
    db.prepare(
      `UPDATE sessions SET step=?, tmp_pickup_lat=COALESCE(?, tmp_pickup_lat),
       tmp_pickup_lon=COALESCE(?, tmp_pickup_lon), tmp_drop_text=COALESCE(?, tmp_drop_text),
       updated_at=? WHERE tg_id=?`
    ).run(
      step,
      extra.tmp_pickup_lat ?? null,
      extra.tmp_pickup_lon ?? null,
      extra.tmp_drop_text ?? null,
      now(),
      tgId
    );
  }
}

function getSession(tgId) {
  return db.prepare(`SELECT * FROM sessions WHERE tg_id=?`).get(tgId);
}

function clearSession(tgId) {
  db.prepare(`DELETE FROM sessions WHERE tg_id=?`).run(tgId);
}

// haversine km
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

// price rule: 3.50 up to 3km, then 0.40 per each extra 1km (ceil)
function calcPrice(distanceKm) {
  if (distanceKm <= 3) return 3.5;
  const extra = Math.ceil(distanceKm - 3);
  return +(3.5 + extra * 0.4).toFixed(2);
}

// main menu keyboard
function mainKb() {
  return {
    keyboard: [
      [{ text: "🚕 Taksi çağır" }],
      [{ text: "🚖 Sürücü paneli" }],
    ],
    resize_keyboard: true,
  };
}

function driverKb(isOnline) {
  return {
    keyboard: [
      [{ text: isOnline ? "🟢 Online" : "⚪ Offline" }],
      [{ text: "📝 Qeydiyyat" }],
      [{ text: "⬅️ Geri" }],
    ],
    resize_keyboard: true,
  };
}

function requestLocationKb(backText = "⬅️ Geri") {
  return {
    keyboard: [
      [{ text: "📍 Lokasiyanı göndər", request_location: true }],
      [{ text: backText }],
    ],
    resize_keyboard: true,
  };
}

// pick nearest approved+online drivers (max 10)
function getCandidateDrivers(pLat, pLon, limit = 10) {
  const rows = db
    .prepare(
      `SELECT tg_id, last_lat, last_lon
       FROM drivers
       WHERE is_approved=1 AND is_online=1 AND last_lat IS NOT NULL AND last_lon IS NOT NULL`
    )
    .all();

  const scored = rows
    .map((d) => ({
      tg_id: d.tg_id,
      dist: haversineKm(pLat, pLon, d.last_lat, d.last_lon),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);

  return scored;
}

// assign order to first driver (simple MVP). You can later make “offer window”.
function assignOrder(orderId, pLat, pLon) {
  const candidates = getCandidateDrivers(pLat, pLon, 10);
  if (candidates.length === 0) return null;

  const driverId = candidates[0].tg_id;
  db.prepare(`UPDATE orders SET driver_id=?, status='offered', updated_at=? WHERE id=?`).run(
    driverId,
    now(),
    orderId
  );
  return driverId;
}

async function sendToDriverOffer(driverId, order) {
  const waze = `https://waze.com/ul?ll=${order.pickup_lat},${order.pickup_lon}&navigate=yes`;
  await tg("sendMessage", {
    chat_id: driverId,
    text:
      `🚕 *Yeni sifariş*\n` +
      `📍 Götürmə: ${order.pickup_lat.toFixed(5)}, ${order.pickup_lon.toFixed(5)}\n` +
      `🎯 Haraya: ${order.drop_text}\n` +
      `💰 Qiymət: *${order.price_azn.toFixed(2)} AZN* (nağd)\n\n` +
      `Waze: ${waze}\n\n` +
      `Qəbul edirsən?`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Qəbul et", callback_data: `accept:${order.id}` }],
        [{ text: "❌ Rədd et", callback_data: `reject:${order.id}` }],
      ],
    },
  });
}

// ---- Routes ----
app.get("/", (req, res) => res.send("PayTaksi bot is running 🚕"));

app.post(`/tg/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    // callback buttons (accept/reject)
    if (update.callback_query) {
      const cq = update.callback_query;
      const fromId = cq.from.id;
      const data = cq.data || "";

      const [cmd, idStr] = data.split(":");
      const orderId = parseInt(idStr, 10);

      // ack callback
      await tg("answerCallbackQuery", { callback_query_id: cq.id });

      const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
      if (!order) {
        await tg("sendMessage", { chat_id: fromId, text: "Sifariş tapılmadı." });
        return res.sendStatus(200);
      }

      // only assigned driver can act in MVP
      if (order.driver_id !== fromId) {
        await tg("sendMessage", { chat_id: fromId, text: "Bu sifariş sənə aid deyil." });
        return res.sendStatus(200);
      }

      if (cmd === "accept") {
        // lock
        db.prepare(`UPDATE orders SET status='accepted', updated_at=? WHERE id=?`).run(now(), orderId);

        await tg("sendMessage", { chat_id: fromId, text: "✅ Sifarişi qəbul etdin." });
        await tg("sendMessage", {
          chat_id: order.customer_id,
          text: `✅ Sürücü tapıldı!\nSifariş #${order.id}\nSürücü yola çıxır.`,
        });
      }

      if (cmd === "reject") {
        db.prepare(`UPDATE orders SET status='rejected', updated_at=? WHERE id=?`).run(now(), orderId);
        await tg("sendMessage", { chat_id: fromId, text: "❌ Sifarişi rədd etdin." });
        await tg("sendMessage", {
          chat_id: order.customer_id,
          text: `❌ Sürücü sifarişi qəbul etmədi.\nYenidən axtarırıq...`,
        });
        // try re-assign to next closest (MVP: just try again excluding this driver)
        // simplest: turn driver offline temporarily (optional). Here: do nothing and tell customer to retry.
        await tg("sendMessage", {
          chat_id: order.customer_id,
          text: "Zəhmət olmasa yenidən '🚕 Taksi çağır' edin.",
          reply_markup: mainKb(),
        });
      }

      return res.sendStatus(200);
    }

    // normal messages
    if (update.message) {
      const m = update.message;
      const tgId = m.from.id;
      upsertUser(tgId);

      const text = m.text;

      // location update (driver or customer)
      if (m.location) {
        const lat = m.location.latitude;
        const lon = m.location.longitude;

        const sess = getSession(tgId);
        const isDriver = db.prepare(`SELECT 1 FROM drivers WHERE tg_id=?`).get(tgId);

        // if in customer flow: waiting pickup
        if (sess && sess.step === "customer_wait_pickup") {
          setStep(tgId, "customer_wait_drop", {
            tmp_pickup_lat: lat,
            tmp_pickup_lon: lon,
          });

          await tg("sendMessage", {
            chat_id: tgId,
            text: "🎯 Haraya gedirsən? Ünvanı yaz (mətn).",
            reply_markup: { remove_keyboard: true },
          });
          return res.sendStatus(200);
        }

        // driver location store (if driver exists)
        if (isDriver) {
          db.prepare(
            `UPDATE drivers SET last_lat=?, last_lon=?, updated_at=? WHERE tg_id=?`
          ).run(lat, lon, now(), tgId);
          // no spam
          return res.sendStatus(200);
        }

        // otherwise ignore
        return res.sendStatus(200);
      }

      // /start
      if (text === "/start") {
        await tg("sendMessage", {
          chat_id: tgId,
          text: "🚕 PayTaksi\n\nXoş gəldin! Aşağıdan seçim et:",
          reply_markup: mainKb(),
        });
        clearSession(tgId);
        return res.sendStatus(200);
      }

      // back
      if (text === "⬅️ Geri") {
        await tg("sendMessage", {
          chat_id: tgId,
          text: "Əsas menyu:",
          reply_markup: mainKb(),
        });
        clearSession(tgId);
        return res.sendStatus(200);
      }

      // CUSTOMER: start order
      if (text === "🚕 Taksi çağır") {
        setStep(tgId, "customer_wait_pickup");
        await tg("sendMessage", {
          chat_id: tgId,
          text: "📍 Zəhmət olmasa götürülmə lokasiyanı göndər..",
          reply_markup: requestLocationKb("⬅️ Geri"),
        });
        return res.sendStatus(200);
      }

      // CUSTOMER: receive drop text
      const sess = getSession(tgId);
      if (sess && sess.step === "customer_wait_drop" && typeof text === "string" && text.length > 2) {
        // Create order (distance: MVP unknown without routing; for now use 3km base, later add routing)
        const pickupLat = sess.tmp_pickup_lat;
        const pickupLon = sess.tmp_pickup_lon;
        const dropText = text.trim();

        // MVP: distance estimate placeholder = 3km
        const distanceKm = 3.0;
        const price = calcPrice(distanceKm);

        const info = db
          .prepare(
            `INSERT INTO orders(customer_id, status, pickup_lat, pickup_lon, drop_text, distance_km, price_azn, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?)`
          )
          .run(tgId, "searching", pickupLat, pickupLon, dropText, distanceKm, price, now(), now());

        const orderId = info.lastInsertRowid;

        clearSession(tgId);

        await tg("sendMessage", {
          chat_id: tgId,
          text:
            `✅ Sifariş yaradıldı (#${orderId})\n` +
            `💰 Təxmini qiymət: ${price.toFixed(2)} AZN (nağd)\n` +
            `Sürücü axtarılır...`,
          reply_markup: mainKb(),
        });

        const driverId = assignOrder(orderId, pickupLat, pickupLon);

        if (!driverId) {
          db.prepare(`UPDATE orders SET status='no_driver', updated_at=? WHERE id=?`).run(now(), orderId);
          await tg("sendMessage", {
            chat_id: tgId,
            text: "❌ Hal-hazırda online sürücü tapılmadı. Bir az sonra yenidən cəhd edin.",
          });
          return res.sendStatus(200);
        }

        const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
        await sendToDriverOffer(driverId, order);

        await tg("sendMessage", {
          chat_id: tgId,
          text: "📨 Sifariş sürücüyə göndərildi. Cavab gözlənilir...",
        });

        return res.sendStatus(200);
      }

      // DRIVER panel
      if (text === "🚖 Sürücü paneli") {
        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        const isOnline = d ? !!d.is_online : false;

        await tg("sendMessage", {
          chat_id: tgId,
          text:
            "🚖 Sürücü paneli\n\n" +
            (d
              ? `Status: ${d.is_approved ? "✅ Təsdiqli" : "⏳ Təsdiq gözləyir"}\n`
              : "Sən hələ sürücü kimi qeydiyyatdan keçməmisən.\n") +
            `Online: ${isOnline ? "🟢" : "⚪"}\n\n` +
            "Seçim et:",
          reply_markup: driverKb(isOnline),
        });
        return res.sendStatus(200);
      }

      // DRIVER: registration
      if (text === "📝 Qeydiyyat") {
        // create driver row if not exists
        db.prepare(
          `INSERT INTO drivers(tg_id, is_approved, is_online, updated_at) VALUES(?,?,?,?)
           ON CONFLICT(tg_id) DO UPDATE SET tg_id=excluded.tg_id`
        ).run(tgId, 0, 0, now());

        setStep(tgId, "driver_reg_name");
        await tg("sendMessage", {
          chat_id: tgId,
          text: "Ad Soyad yaz:",
          reply_markup: { remove_keyboard: true },
        });
        return res.sendStatus(200);
      }

      // DRIVER: online/offline toggle
      if (text === "🟢 Online" || text === "⚪ Offline") {
        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        if (!d) {
          await tg("sendMessage", { chat_id: tgId, text: "Əvvəl '📝 Qeydiyyat' edin." });
          return res.sendStatus(200);
        }
        if (!d.is_approved) {
          await tg("sendMessage", { chat_id: tgId, text: "Admin təsdiqi gözlənilir." });
          return res.sendStatus(200);
        }

        const newState = d.is_online ? 0 : 1;
        db.prepare(`UPDATE drivers SET is_online=?, updated_at=? WHERE tg_id=?`).run(newState, now(), tgId);

        // request location once when going online
        if (newState === 1) {
          await tg("sendMessage", {
            chat_id: tgId,
            text: "🟢 Online oldun. Lokasiyanı göndər ki, yaxın sifarişlər gəlsin.",
            reply_markup: requestLocationKb("⬅️ Geri"),
          });
        } else {
          await tg("sendMessage", {
            chat_id: tgId,
            text: "⚪ Offline oldun.",
            reply_markup: driverKb(false),
          });
        }
        return res.sendStatus(200);
      }

      // DRIVER registration steps
      if (sess && sess.step === "driver_reg_name" && typeof text === "string") {
        db.prepare(`UPDATE drivers SET full_name=?, updated_at=? WHERE tg_id=?`).run(text.trim(), now(), tgId);
        setStep(tgId, "driver_reg_phone");
        await tg("sendMessage", { chat_id: tgId, text: "Telefon nömrəni yaz:" });
        return res.sendStatus(200);
      }
      if (sess && sess.step === "driver_reg_phone" && typeof text === "string") {
        db.prepare(`UPDATE drivers SET phone=?, updated_at=? WHERE tg_id=?`).run(text.trim(), now(), tgId);
        setStep(tgId, "driver_reg_car");
        await tg("sendMessage", { chat_id: tgId, text: "Maşın (məs: Prius 2016) yaz:" });
        return res.sendStatus(200);
      }
      if (sess && sess.step === "driver_reg_car" && typeof text === "string") {
        db.prepare(`UPDATE drivers SET car=?, updated_at=? WHERE tg_id=?`).run(text.trim(), now(), tgId);
        setStep(tgId, "driver_reg_plate");
        await tg("sendMessage", { chat_id: tgId, text: "Dövlət nömrəsi yaz:" });
        return res.sendStatus(200);
      }
      if (sess && sess.step === "driver_reg_plate" && typeof text === "string") {
        db.prepare(`UPDATE drivers SET plate=?, is_online=0, updated_at=? WHERE tg_id=?`).run(
          text.trim(),
          now(),
          tgId
        );
        clearSession(tgId);

        await tg("sendMessage", {
          chat_id: tgId,
          text: "✅ Qeydiyyat göndərildi. Admin təsdiq edəndən sonra Online ola biləcəksən.",
          reply_markup: driverKb(false),
        });

        // (MVP) Admin approval later: for now you approve via DB/manual
        return res.sendStatus(200);
      }

      // default
      // keep quiet to avoid spam
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
