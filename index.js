/**
 * PayTaksi Telegram Bot – UPGRADE PACK
 * Adds:
 * 1) Auto ETA refresh (every 2 minutes) + live driver map link
 * 2) Rating system (customer -> driver, 1..5 stars)
 * 3) Daily earnings report (driver/admin)
 * 4) "AI dispatch" (best driver selection by distance + rating + acceptance rate)
 *
 * Keeps:
 * - Webhook: /tg/<WEBHOOK_SECRET>
 * - Customer flow: pickup -> drop -> OSRM distance -> price (3.50 up to 3km, +0.40/km after)
 * - Driver flow: registration -> admin approval -> online -> offers -> accept/reject
 * - Trip statuses: arrived/starttrip/finish/cancel (+ customer notifications)
 * - Admin commands: /admin, /admin_live, /admin_drivers, /admin_order <id>
 *
 * ENV:
 *   BOT_TOKEN=xxxxx
 *   WEBHOOK_SECRET=paytaksi_bot
 *   ADMIN_IDS=1326729201,....
 *   OFFER_DRIVERS=5
 */

const express = require("express");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));
const OFFER_DRIVERS = Number(process.env.OFFER_DRIVERS || 5);

if (!BOT_TOKEN) console.error("❌ BOT_TOKEN missing");
if (!WEBHOOK_SECRET) console.error("❌ WEBHOOK_SECRET missing");

const db = new Database("paytaksi.sqlite");

const now = () => Math.floor(Date.now() / 1000);
const isAdmin = (id) => ADMIN_IDS.includes(Number(id));

// Node 18+ => global fetch exists
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------------- DB ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  lang TEXT DEFAULT 'az',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  tg_id INTEGER PRIMARY KEY,
  step TEXT,
  tmp_pickup_lat REAL,
  tmp_pickup_lon REAL,
  tmp_drop_lat REAL,
  tmp_drop_lon REAL,
  tmp_drop_text TEXT,
  updated_at INTEGER
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
  status TEXT, -- searching/accepted/arrived/in_trip/finished/cancelled/no_driver
  pickup_lat REAL,
  pickup_lon REAL,
  drop_lat REAL,
  drop_lon REAL,
  drop_text TEXT,
  distance_km REAL,
  price_azn REAL,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  driver_id INTEGER,
  status TEXT, -- offered/accepted/rejected/expired
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS driver_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  driver_id INTEGER,
  customer_id INTEGER,
  stars INTEGER,
  created_at INTEGER
);
`);

function safeAlter(sql) {
  try { db.exec(sql); } catch(e) {}
}

// Add optional columns (won't crash if already exist)
safeAlter(`ALTER TABLE drivers ADD COLUMN avg_rating REAL`);
safeAlter(`ALTER TABLE drivers ADD COLUMN rating_count INTEGER`);
safeAlter(`ALTER TABLE drivers ADD COLUMN offers_total INTEGER`);
safeAlter(`ALTER TABLE drivers ADD COLUMN offers_accepted INTEGER`);
safeAlter(`ALTER TABLE orders ADD COLUMN eta_sec INTEGER`);
safeAlter(`ALTER TABLE orders ADD COLUMN last_eta_push_ts INTEGER`);
safeAlter(`ALTER TABLE orders ADD COLUMN rated INTEGER`);

function upsertUser(tgId) {
  db.prepare(
    `INSERT INTO users(tg_id, created_at) VALUES(?,?)
     ON CONFLICT(tg_id) DO UPDATE SET tg_id=excluded.tg_id`
  ).run(tgId, now());
}
function getUser(tgId) {
  return db.prepare(`SELECT * FROM users WHERE tg_id=?`).get(tgId);
}
function setUserLang(tgId, lang) {
  db.prepare(
    `INSERT INTO users(tg_id, lang, created_at) VALUES(?,?,?)
     ON CONFLICT(tg_id) DO UPDATE SET lang=excluded.lang`
  ).run(tgId, lang, now());
}

function setSession(tgId, step, patch = {}) {
  const exists = db.prepare(`SELECT tg_id FROM sessions WHERE tg_id=?`).get(tgId);
  if (!exists) {
    db.prepare(
      `INSERT INTO sessions(tg_id, step, tmp_pickup_lat, tmp_pickup_lon, tmp_drop_lat, tmp_drop_lon, tmp_drop_text, updated_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(
      tgId,
      step,
      patch.tmp_pickup_lat ?? null,
      patch.tmp_pickup_lon ?? null,
      patch.tmp_drop_lat ?? null,
      patch.tmp_drop_lon ?? null,
      patch.tmp_drop_text ?? null,
      now()
    );
  } else {
    db.prepare(
      `UPDATE sessions SET step=?,
        tmp_pickup_lat=COALESCE(?, tmp_pickup_lat),
        tmp_pickup_lon=COALESCE(?, tmp_pickup_lon),
        tmp_drop_lat=COALESCE(?, tmp_drop_lat),
        tmp_drop_lon=COALESCE(?, tmp_drop_lon),
        tmp_drop_text=COALESCE(?, tmp_drop_text),
        updated_at=? WHERE tg_id=?`
    ).run(
      step,
      patch.tmp_pickup_lat ?? null,
      patch.tmp_pickup_lon ?? null,
      patch.tmp_drop_lat ?? null,
      patch.tmp_drop_lon ?? null,
      patch.tmp_drop_text ?? null,
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

// ---------------- Distance + pricing ----------------
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

// OSRM route (distance + duration). Fallback to haversine.
async function getRoute(pLat, pLon, dLat, dLon) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${pLon},${pLat};${dLon},${dLat}?overview=false`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j?.routes?.[0]) {
      return { km: j.routes[0].distance / 1000, sec: j.routes[0].duration };
    }
  } catch (e) {}
  const km = haversineKm(pLat, pLon, dLat, dLon);
  const sec = Math.max(60, Math.round((km / 35) * 3600)); // fallback 35km/h
  return { km, sec };
}

function calcPrice(distanceKm) {
  const km = Math.max(0, Number(distanceKm) || 0);
  if (km <= 3) return 3.5;
  const extraKm = Math.ceil(km - 3);
  return +(3.5 + extraKm * 0.4).toFixed(2);
}

// ---------------- Waze + Map ----------------
function wazeLinkByLL(lat, lon) {
  return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
}
function wazeLinkByQuery(q) {
  return `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
}
function gmapsLL(lat, lon) {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

function driverStatusKb(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "📍 Gəldim", callback_data: `arrived:${orderId}` },
        { text: "▶️ Başladım", callback_data: `starttrip:${orderId}` },
      ],
      [
        { text: "🏁 Bitirdim", callback_data: `finish:${orderId}` },
        { text: "❌ Ləğv et", callback_data: `cancel:${orderId}` },
      ],
    ],
  };
}

function ratingKb(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "⭐1", callback_data: `rate:${orderId}:1` },
        { text: "⭐2", callback_data: `rate:${orderId}:2` },
        { text: "⭐3", callback_data: `rate:${orderId}:3` },
        { text: "⭐4", callback_data: `rate:${orderId}:4` },
        { text: "⭐5", callback_data: `rate:${orderId}:5` },
      ],
    ],
  };
}

// ---------------- UI texts ----------------
const STR = {
  az: {
    welcome: "Xoş gəldin!\nAşağıdan seçim et:",
    callTaxi: "🚕 Taksi çağır",
    driverPanel: "🚖 Sürücü paneli",
    sendPickup: "📍 Zəhmət olmasa götürülmə lokasiyanı göndər.",
    sendDrop: "🎯 Haraya gedirsən? Lokasiya göndər ya da ünvanı yaz (mətn).",
    searching: "Sürücü axtarılır...",
    noDriver: "❌ Hal-hazırda online sürücü tapılmadı. Sonra yenə yoxla.",
    driverAwaitApprove:
      "✅ Qeydiyyat göndərildi. Admin təsdiq edəndən sonra Online ola biləcəksən.",
    needRegister: "Əvvəl 📝 Qeydiyyat edin.",
    needApprove: "Admin təsdiqi gözlənilir.",
    onlineAskLoc: "🟢 Online oldun. Lokasiyanı göndər ki, yaxın sifarişlər gəlsin.",
    langChoose: "Dil seç:",
    orderCreated: (id, km, price) =>
      `✅ Sifariş yaradıldı (#${id})\n📏 Məsafə: ${km.toFixed(2)} km\n💰 Qiymət: ${price.toFixed(
        2
      )} AZN (nağd)\n\n📨 Sifariş sürücülərə göndərildi.`,
    driverAcceptedToDriver: (id) => `✅ Sifarişi qəbul etdin. (#${id})`,
    driverAcceptedToCustomer: (id, d, etaMin, map) =>
      `✅ Sürücü tapıldı!\nSifariş #${id}\n\n👤 ${d.full_name}\n📞 ${d.phone}\n🚗 ${d.car}\n🔢 ${d.plate}\n\n⏱️ ETA: ${etaMin} dəq\n📍 Canlı xəritə: ${map}\n\nSürücü yola çıxır.`,
    orderAlreadyTaken: "⚠️ Bu sifariş artıq başqa sürücü tərəfindən götürüldü.",
    driverRejected: "❌ Sifarişi rədd etdin.",
    pendingNone: "Pending sürücü yoxdur.",

    driverArrivedToCustomer: (id) => `📍 Sürücü gəldi. (Sifariş #${id})`,
    tripStartedToCustomer: (id) => `▶️ Sürüş başladı. (Sifariş #${id})`,
    tripFinishedToCustomer: (id, price) =>
      `🏁 Sürüş bitdi. (Sifariş #${id})\n💰 Ödəniləcək: ${Number(price).toFixed(2)} AZN (nağd)`,
    orderCancelledToCustomer: (id) => `❌ Sifariş ləğv edildi. (#${id})`,
    orderCancelledToDriver: (id) => `❌ Sifarişi ləğv etdin. (#${id})`,

    rateAsk: (id) => `⭐ Zəhmət olmasa sürücünü qiymətləndir. (Sifariş #${id})`,
    rateThanks: "✅ Təşəkkürlər! Qiymət qeydə alındı.",
    dailyDriver: (sum, cnt) => `💰 Bu gün (AZT) qazancın: ${sum.toFixed(2)} AZN\n✅ Bitən sürüş: ${cnt}`,
    dailyAdmin: (sum, cnt) => `💼 Bu gün (AZT) ümumi dövriyyə: ${sum.toFixed(2)} AZN\n✅ Bitən sürüş: ${cnt}`,
  },
};

function t(lang, key, ...args) {
  const L = STR[lang] ? lang : "az";
  const v = STR[L][key];
  return typeof v === "function" ? v(...args) : v;
}

function mainKb(lang) {
  return {
    keyboard: [[{ text: t(lang, "callTaxi") }], [{ text: t(lang, "driverPanel") }]],
    resize_keyboard: true,
  };
}

function locKb() {
  return {
    keyboard: [[{ text: "📍 Lokasiya göndər", request_location: true }], [{ text: "⬅️ Geri" }]],
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

// ---------------- Ratings + stats ----------------
function ensureDriverStats(driverId) {
  db.prepare(
    `INSERT INTO drivers(tg_id, updated_at) VALUES(?,?)
     ON CONFLICT(tg_id) DO UPDATE SET tg_id=excluded.tg_id`
  ).run(driverId, now());
  const d = db.prepare(`SELECT avg_rating, rating_count, offers_total, offers_accepted FROM drivers WHERE tg_id=?`).get(driverId);
  return {
    avg_rating: Number(d?.avg_rating || 0),
    rating_count: Number(d?.rating_count || 0),
    offers_total: Number(d?.offers_total || 0),
    offers_accepted: Number(d?.offers_accepted || 0),
  };
}

function addOfferStat(driverId, accepted) {
  ensureDriverStats(driverId);
  db.prepare(`UPDATE drivers SET offers_total=COALESCE(offers_total,0)+1, offers_accepted=COALESCE(offers_accepted,0)+?, updated_at=? WHERE tg_id=?`)
    .run(accepted ? 1 : 0, now(), driverId);
}

function addRating(driverId, customerId, orderId, stars) {
  ensureDriverStats(driverId);
  db.prepare(`INSERT INTO driver_ratings(order_id, driver_id, customer_id, stars, created_at) VALUES(?,?,?,?,?)`)
    .run(orderId, driverId, customerId, stars, now());

  const d = db.prepare(`SELECT avg_rating, rating_count FROM drivers WHERE tg_id=?`).get(driverId);
  const cnt = Number(d?.rating_count || 0);
  const avg = Number(d?.avg_rating || 0);
  const newCnt = cnt + 1;
  const newAvg = ((avg * cnt) + stars) / newCnt;

  db.prepare(`UPDATE drivers SET avg_rating=?, rating_count=?, updated_at=? WHERE tg_id=?`)
    .run(newAvg, newCnt, now(), driverId);
}

// ---------------- AI dispatch ----------------
function computeScore(distKm, avgRating, acceptRate) {
  // Lower is better.
  // rating helps (up to ~1.0), accept rate helps (up to ~0.7)
  const ratingBonus = Math.min(5, Math.max(0, avgRating)) * 0.2;
  const acceptBonus = Math.min(1, Math.max(0, acceptRate)) * 0.7;
  return distKm - ratingBonus - acceptBonus;
}

function getCandidateDriversAI(pLat, pLon, limit = OFFER_DRIVERS) {
  const rows = db
    .prepare(
      `SELECT tg_id, last_lat, last_lon,
              COALESCE(avg_rating,0) AS avg_rating,
              COALESCE(rating_count,0) AS rating_count,
              COALESCE(offers_total,0) AS offers_total,
              COALESCE(offers_accepted,0) AS offers_accepted
       FROM drivers
       WHERE is_approved=1 AND is_online=1
         AND last_lat IS NOT NULL AND last_lon IS NOT NULL`
    )
    .all();

  // Consider more then cut (AI ranking)
  const ranked = rows.map((d) => {
    const dist = haversineKm(pLat, pLon, d.last_lat, d.last_lon);
    const total = Number(d.offers_total || 0);
    const acc = Number(d.offers_accepted || 0);
    const acceptRate = total > 0 ? (acc / total) : 0.5; // neutral if no data
    const score = computeScore(dist, Number(d.avg_rating || 0), acceptRate);
    return { tg_id: d.tg_id, dist, score };
  }).sort((a,b) => a.score - b.score);

  return ranked.slice(0, limit);
}

async function sendDriverOffer(driverId, order) {
  const pickupWaze = wazeLinkByLL(order.pickup_lat, order.pickup_lon);

  let dropWaze = "-";
  if (order.drop_lat && order.drop_lon) dropWaze = wazeLinkByLL(order.drop_lat, order.drop_lon);
  else if (order.drop_text) dropWaze = wazeLinkByQuery(order.drop_text);

  await tg("sendMessage", {
    chat_id: driverId,
    text:
      `🚕 Yeni sifariş (#${order.id})\n` +
      `📍 Götürmə: ${order.pickup_lat.toFixed(5)}, ${order.pickup_lon.toFixed(5)}\n` +
      `🎯 Təyinat: ${
        order.drop_text ||
        (order.drop_lat && order.drop_lon
          ? `${order.drop_lat.toFixed(5)},${order.drop_lon.toFixed(5)}`
          : "-")
      }\n` +
      `📏 ${Number(order.distance_km || 0).toFixed(2)} km\n` +
      `💰 ${Number(order.price_azn || 0).toFixed(2)} AZN (nağd)\n\n` +
      `🧭 Pickup Waze: ${pickupWaze}\n` +
      `🧭 Drop Waze: ${dropWaze}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Qəbul et", callback_data: `accept_order:${order.id}` }],
        [{ text: "❌ Rədd et", callback_data: `reject_order:${order.id}` }],
      ],
    },
  });
}

// ---------------- Daily earnings (AZT +04:00) ----------------
const AZT_OFFSET = 4 * 3600; // seconds
function dayStartAz(ts) {
  // Start of day in AZT (UTC+4), returned as unix seconds in UTC
  const day = Math.floor((ts + AZT_OFFSET) / 86400);
  return day * 86400 - AZT_OFFSET;
}
function dayEndAz(ts) {
  return dayStartAz(ts) + 86400;
}

function dailyEarningsForDriver(driverId, tsNow) {
  const s = dayStartAz(tsNow);
  const e = dayEndAz(tsNow);
  const row = db.prepare(
    `SELECT COALESCE(SUM(price_azn),0) as sum, COUNT(*) as cnt
     FROM orders
     WHERE driver_id=? AND status='finished' AND updated_at>=? AND updated_at<?`
  ).get(driverId, s, e);
  return { sum: Number(row.sum || 0), cnt: Number(row.cnt || 0) };
}
function dailyEarningsAll(tsNow) {
  const s = dayStartAz(tsNow);
  const e = dayEndAz(tsNow);
  const row = db.prepare(
    `SELECT COALESCE(SUM(price_azn),0) as sum, COUNT(*) as cnt
     FROM orders
     WHERE status='finished' AND updated_at>=? AND updated_at<?`
  ).get(s, e);
  return { sum: Number(row.sum || 0), cnt: Number(row.cnt || 0) };
}

// ---------------- Auto ETA refresh (every 2 minutes) ----------------
async function refreshEtas() {
  try {
    const ts = now();
    const active = db.prepare(
      `SELECT o.id, o.customer_id, o.driver_id, o.status, o.pickup_lat, o.pickup_lon, o.drop_lat, o.drop_lon, o.drop_text,
              COALESCE(o.last_eta_push_ts,0) as last_eta_push_ts
       FROM orders o
       WHERE o.status IN ('accepted','arrived','in_trip') AND o.driver_id IS NOT NULL`
    ).all();

    for (const o of active) {
      if (!o.driver_id) continue;
      if (ts - Number(o.last_eta_push_ts || 0) < 120) continue;

      const d = db.prepare(`SELECT last_lat, last_lon FROM drivers WHERE tg_id=?`).get(o.driver_id);
      if (!d || d.last_lat == null || d.last_lon == null) continue;

      // Target depends on status
      let targetLat = o.pickup_lat, targetLon = o.pickup_lon, title = "Pickup";
      if (o.status === "in_trip") {
        if (o.drop_lat && o.drop_lon) {
          targetLat = o.drop_lat; targetLon = o.drop_lon; title = "Drop";
        } else {
          // no coords => just send map, skip ETA calc
          await tg("sendMessage", {
            chat_id: o.customer_id,
            text: `📍 Sürücünün canlı xəritəsi:\n${gmapsLL(d.last_lat, d.last_lon)}`,
          });
          db.prepare(`UPDATE orders SET last_eta_push_ts=?, updated_at=? WHERE id=?`).run(ts, ts, o.id);
          continue;
        }
      }

      const route = await getRoute(d.last_lat, d.last_lon, targetLat, targetLon);
      const etaMin = Math.max(1, Math.ceil(route.sec / 60));

      db.prepare(`UPDATE orders SET eta_sec=?, last_eta_push_ts=?, updated_at=? WHERE id=?`).run(route.sec, ts, ts, o.id);

      await tg("sendMessage", {
        chat_id: o.customer_id,
        text: `⏱️ ETA yeniləndi (${title}): ${etaMin} dəq\n📍 Canlı xəritə:\n${gmapsLL(d.last_lat, d.last_lon)}`,
      });
    }
  } catch (e) {
    console.error("ETA refresh error:", e);
  }
}
setInterval(refreshEtas, 120000);

// ---------------- Routes ----------------
app.get("/", (req, res) => res.send("PayTaksi bot is running 🚕"));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/debug", (req, res) =>
  res.json({
    ok: true,
    webhook_path: `/tg/${WEBHOOK_SECRET}`,
    has_token: !!BOT_TOKEN,
    admins: ADMIN_IDS,
    offer_drivers: OFFER_DRIVERS,
  })
);

// ✅ Webhook endpoint
app.post(`/tg/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    // -------- CALLBACK QUERIES --------
    if (update.callback_query) {
      const cq = update.callback_query;
      const fromId = cq.from.id;
      const data = cq.data || "";

      await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});

      // language
      if (data.startsWith("lang:")) {
        const lang = data.split(":")[1];
        setUserLang(fromId, lang);
        await tg("sendMessage", { chat_id: fromId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
        return res.sendStatus(200);
      }

      // rating callback
      if (data.startsWith("rate:")) {
        const parts = data.split(":");
        const orderId = Number(parts[1]);
        const stars = Math.max(1, Math.min(5, Number(parts[2] || 0)));

        const o = db.prepare(`SELECT id, customer_id, driver_id, status, COALESCE(rated,0) as rated FROM orders WHERE id=?`).get(orderId);
        if (!o) return res.sendStatus(200);
        if (Number(o.customer_id) !== Number(fromId)) return res.sendStatus(200);
        if (o.status !== "finished") return res.sendStatus(200);
        if (Number(o.rated) === 1) {
          await tg("sendMessage", { chat_id: fromId, text: t("az", "rateThanks") });
          return res.sendStatus(200);
        }

        addRating(o.driver_id, o.customer_id, orderId, stars);
        db.prepare(`UPDATE orders SET rated=1, updated_at=? WHERE id=?`).run(now(), orderId);

        await tg("sendMessage", { chat_id: fromId, text: t("az", "rateThanks") });
        return res.sendStatus(200);
      }

      // admin approve/reject driver
      if (data.startsWith("appr:") || data.startsWith("rejdrv:")) {
        if (!isAdmin(fromId)) {
          await tg("sendMessage", { chat_id: fromId, text: "Admin deyil." });
          return res.sendStatus(200);
        }
        const [cmd, idStr] = data.split(":");
        const driverId = Number(idStr);

        if (cmd === "appr") {
          db.prepare(`UPDATE drivers SET is_approved=1, updated_at=? WHERE tg_id=?`).run(now(), driverId);
          await tg("sendMessage", { chat_id: fromId, text: `✅ Təsdiqləndi: ${driverId}` });
          await tg("sendMessage", { chat_id: driverId, text: "✅ Admin səni təsdiqlədi. İndi Online ola bilərsən.", reply_markup: driverKb(false) });
        } else {
          db.prepare(`UPDATE drivers SET is_approved=0, updated_at=? WHERE tg_id=?`).run(now(), driverId);
          await tg("sendMessage", { chat_id: fromId, text: `❌ Rədd edildi: ${driverId}` });
          await tg("sendMessage", { chat_id: driverId, text: "❌ Admin qeydiyyatı rədd etdi." });
        }
        return res.sendStatus(200);
      }

      // ------------------- DRIVER ACCEPT / REJECT -------------------
      if (data.startsWith("accept_order:") || data.startsWith("reject_order:")) {
        const [cmd, idStr] = data.split(":");
        const orderId = Number(idStr);

        const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
        if (!order) {
          await tg("sendMessage", { chat_id: fromId, text: "Sifariş tapılmadı." });
          return res.sendStatus(200);
        }

        const driver = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(fromId);
        if (!driver || !driver.is_approved) {
          await tg("sendMessage", { chat_id: fromId, text: "Sürücü təsdiqli deyil." });
          return res.sendStatus(200);
        }

        const offer = db.prepare(`SELECT * FROM offers WHERE order_id=? AND driver_id=? AND status='offered'`).get(orderId, fromId);
        if (!offer) {
          await tg("sendMessage", { chat_id: fromId, text: "Bu sifariş sənə aid deyil və ya artıq bağlanıb." });
          return res.sendStatus(200);
        }

        const latest = db.prepare(`SELECT status, driver_id FROM orders WHERE id=?`).get(orderId);

        if (cmd === "reject_order") {
          db.prepare(`UPDATE offers SET status='rejected', updated_at=? WHERE id=?`).run(now(), offer.id);
          addOfferStat(fromId, false);
          await tg("sendMessage", { chat_id: fromId, text: t("az", "driverRejected") });

          const left = db.prepare(`SELECT COUNT(*) c FROM offers WHERE order_id=? AND status='offered'`).get(orderId).c;
          if (!left && latest.status !== "accepted") {
            db.prepare(`UPDATE orders SET status='no_driver', updated_at=? WHERE id=?`).run(now(), orderId);
            const u = getUser(order.customer_id) || { lang: "az" };
            await tg("sendMessage", { chat_id: order.customer_id, text: t(u.lang || "az", "noDriver") });
          }
          return res.sendStatus(200);
        }

        // accept (atomic lock)
        const locked = db.prepare(`UPDATE orders SET status='accepted', driver_id=?, updated_at=? WHERE id=? AND status='searching'`).run(fromId, now(), orderId);
        if (locked.changes === 0) {
          db.prepare(`UPDATE offers SET status='expired', updated_at=? WHERE id=?`).run(now(), offer.id);
          await tg("sendMessage", { chat_id: fromId, text: t("az", "orderAlreadyTaken") });
          return res.sendStatus(200);
        }

        db.prepare(`UPDATE offers SET status='accepted', updated_at=? WHERE id=?`).run(now(), offer.id);
        db.prepare(`UPDATE offers SET status='expired', updated_at=? WHERE order_id=? AND driver_id<>? AND status='offered'`).run(now(), orderId, fromId);

        addOfferStat(fromId, true);

        await tg("sendMessage", { chat_id: fromId, text: t("az", "driverAcceptedToDriver", orderId) });

        const driverFull = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(fromId);
        const customerUser = getUser(order.customer_id) || { lang: "az" };

        // ETA from driver -> pickup (if driver has coords)
        let etaMin = 0;
        if (driverFull?.last_lat != null && driverFull?.last_lon != null) {
          const route = await getRoute(driverFull.last_lat, driverFull.last_lon, order.pickup_lat, order.pickup_lon);
          etaMin = Math.max(1, Math.ceil(route.sec / 60));
          db.prepare(`UPDATE orders SET eta_sec=?, last_eta_push_ts=?, updated_at=? WHERE id=?`).run(route.sec, now(), now(), orderId);
        }
        const map = (driverFull?.last_lat != null && driverFull?.last_lon != null)
          ? gmapsLL(driverFull.last_lat, driverFull.last_lon)
          : "-";

        await tg("sendMessage", {
          chat_id: order.customer_id,
          text: t(customerUser.lang || "az", "driverAcceptedToCustomer", orderId, driverFull, etaMin, map),
        });

        // send pickup + status keyboard to driver
        const pickupWaze = wazeLinkByLL(order.pickup_lat, order.pickup_lon);
        let dropWaze = "-";
        if (order.drop_lat && order.drop_lon) dropWaze = wazeLinkByLL(order.drop_lat, order.drop_lon);
        else if (order.drop_text) dropWaze = wazeLinkByQuery(order.drop_text);

        await tg("sendMessage", { chat_id: fromId, text: `🧭 Naviqasiya\nPickup: ${pickupWaze}\nDrop: ${dropWaze}` });
        await tg("sendMessage", { chat_id: fromId, text: `🧩 Sifariş idarəetmə düymələri (#${orderId})`, reply_markup: driverStatusKb(orderId) });

        return res.sendStatus(200);
      }

      // ---- DRIVER STATUS UPDATES: arrived/starttrip/finish/cancel ----
      if (data.startsWith("arrived:") || data.startsWith("starttrip:") || data.startsWith("finish:") || data.startsWith("cancel:")) {
        const [cmd, idStr] = data.split(":");
        const orderId = Number(idStr);
        const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
        if (!order) {
          await tg("sendMessage", { chat_id: fromId, text: "Sifariş tapılmadı." });
          return res.sendStatus(200);
        }

        if (Number(order.driver_id) !== Number(fromId)) {
          await tg("sendMessage", { chat_id: fromId, text: "Bu sifariş sənə aid deyil." });
          return res.sendStatus(200);
        }

        if (["finished", "cancelled"].includes(order.status)) {
          await tg("sendMessage", { chat_id: fromId, text: "Bu sifariş artıq bağlanıb." });
          return res.sendStatus(200);
        }

        const cust = getUser(order.customer_id) || { lang: "az" };
        const custLang = cust.lang || "az";

        if (cmd === "arrived") {
          db.prepare(`UPDATE orders SET status='arrived', updated_at=? WHERE id=?`).run(now(), orderId);
          await tg("sendMessage", { chat_id: fromId, text: `📍 “Gəldim” qeyd edildi. (#${orderId})` });
          await tg("sendMessage", { chat_id: order.customer_id, text: t(custLang, "driverArrivedToCustomer", orderId) });
          return res.sendStatus(200);
        }

        if (cmd === "starttrip") {
          db.prepare(`UPDATE orders SET status='in_trip', updated_at=? WHERE id=?`).run(now(), orderId);

          let dropNav = "-";
          if (order.drop_lat && order.drop_lon) dropNav = wazeLinkByLL(order.drop_lat, order.drop_lon);
          else if (order.drop_text) dropNav = wazeLinkByQuery(order.drop_text);

          await tg("sendMessage", { chat_id: fromId, text: `▶️ Sürüş başladı. (#${orderId})\n🧭 Təyinat Waze: ${dropNav}` });
          await tg("sendMessage", { chat_id: order.customer_id, text: t(custLang, "tripStartedToCustomer", orderId) });
          return res.sendStatus(200);
        }

        if (cmd === "finish") {
          db.prepare(`UPDATE orders SET status='finished', updated_at=? WHERE id=?`).run(now(), orderId);
          await tg("sendMessage", { chat_id: fromId, text: `🏁 Sürüş bitdi. (#${orderId})` });

          await tg("sendMessage", {
            chat_id: order.customer_id,
            text: t(custLang, "tripFinishedToCustomer", orderId, Number(order.price_azn || 0)),
          });

          // Ask for rating (only once)
          const rated = Number(order.rated || 0);
          if (!rated) {
            await tg("sendMessage", {
              chat_id: order.customer_id,
              text: t(custLang, "rateAsk", orderId),
              reply_markup: ratingKb(orderId),
            });
          }

          return res.sendStatus(200);
        }

        if (cmd === "cancel") {
          db.prepare(`UPDATE orders SET status='cancelled', updated_at=? WHERE id=?`).run(now(), orderId);
          await tg("sendMessage", { chat_id: fromId, text: t("az", "orderCancelledToDriver", orderId) });
          await tg("sendMessage", { chat_id: order.customer_id, text: t(custLang, "orderCancelledToCustomer", orderId) });
          return res.sendStatus(200);
        }
      }

      return res.sendStatus(200);
    }

    // -------- MESSAGES --------
    if (update.message) {
      const m = update.message;
      const tgId = m.from.id;
      upsertUser(tgId);

      const user = getUser(tgId) || { lang: "az" };
      const lang = user.lang || "az";
      const text = m.text;

      // /id
      if (text === "/id" || text === "/ID") {
        await tg("sendMessage", { chat_id: tgId, text: `Sənin Telegram ID: ${tgId}` });
        return res.sendStatus(200);
      }

      // /orders (customer history)
      if (text === "/orders") {
        const rows = db.prepare(`SELECT id,status,distance_km,price_azn,updated_at FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 20`).all(tgId);
        if (!rows.length) {
          await tg("sendMessage", { chat_id: tgId, text: "Sifariş yoxdur." });
          return res.sendStatus(200);
        }
        for (const o of rows) {
          await tg("sendMessage", {
            chat_id: tgId,
            text: `#${o.id} | ${o.status}\n📏 ${Number(o.distance_km||0).toFixed(2)} km\n💰 ${Number(o.price_azn||0).toFixed(2)} AZN`,
          });
        }
        return res.sendStatus(200);
      }

      // /myrides (driver history)
      if (text === "/myrides") {
        const rows = db.prepare(`SELECT id,status,distance_km,price_azn,updated_at FROM orders WHERE driver_id=? ORDER BY created_at DESC LIMIT 20`).all(tgId);
        if (!rows.length) {
          await tg("sendMessage", { chat_id: tgId, text: "Sürüş yoxdur." });
          return res.sendStatus(200);
        }
        for (const o of rows) {
          await tg("sendMessage", {
            chat_id: tgId,
            text: `#${o.id} | ${o.status}\n📏 ${Number(o.distance_km||0).toFixed(2)} km\n💰 ${Number(o.price_azn||0).toFixed(2)} AZN`,
          });
        }
        return res.sendStatus(200);
      }

      // /daily (driver daily earnings)
      if (text === "/daily") {
        const d = dailyEarningsForDriver(tgId, now());
        await tg("sendMessage", { chat_id: tgId, text: t(lang, "dailyDriver", d.sum, d.cnt) });
        return res.sendStatus(200);
      }

      // /admin_daily (admin daily earnings)
      if (text === "/admin_daily") {
        if (!isAdmin(tgId)) return res.sendStatus(200);
        const d = dailyEarningsAll(now());
        await tg("sendMessage", { chat_id: tgId, text: t(lang, "dailyAdmin", d.sum, d.cnt) });
        return res.sendStatus(200);
      }

      // /start -> language choose + menu
      if (text === "/start") {
        await tg("sendMessage", {
          chat_id: tgId,
          text: t("az", "langChoose"),
          reply_markup: {
            inline_keyboard: [
              [{ text: "🇦🇿 AZ", callback_data: "lang:az" }],
              [{ text: "🇬🇧 EN", callback_data: "lang:en" }],
              [{ text: "🇷🇺 RU", callback_data: "lang:ru" }],
            ],
          },
        });
        clearSession(tgId);
        return res.sendStatus(200);
      }

      // /admin list pending
      if (text === "/admin") {
        if (!isAdmin(tgId)) {
          await tg("sendMessage", { chat_id: tgId, text: "Admin deyil." });
          return res.sendStatus(200);
        }
        const pend = db.prepare(`SELECT * FROM drivers WHERE is_approved=0 AND full_name IS NOT NULL ORDER BY updated_at DESC LIMIT 30`).all();
        if (!pend.length) {
          await tg("sendMessage", { chat_id: tgId, text: t(lang, "pendingNone") });
          return res.sendStatus(200);
        }
        for (const d of pend) {
          await tg("sendMessage", {
            chat_id: tgId,
            text: `⏳ Yeni sürücü\n👤 ${d.full_name}\n📞 ${d.phone}\n🚗 ${d.car}\n🔢 ${d.plate}\nID: ${d.tg_id}`,
            reply_markup: { inline_keyboard: [[{ text: "✅ Təsdiq et", callback_data: `appr:${d.tg_id}` }, { text: "❌ Rədd et", callback_data: `rejdrv:${d.tg_id}` }]] },
          });
        }
        return res.sendStatus(200);
      }

      // Admin live orders
      if (text === "/admin_live") {
        if (!isAdmin(tgId)) return res.sendStatus(200);
        const orders = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 20`).all();
        if (!orders.length) {
          await tg("sendMessage", { chat_id: tgId, text: "Sifariş yoxdur." });
          return res.sendStatus(200);
        }
        for (const o of orders) {
          await tg("sendMessage", {
            chat_id: tgId,
            text:
              `#${o.id} | ${o.status}\n` +
              `👤 customer: ${o.customer_id}\n` +
              `🚖 driver: ${o.driver_id || "-"}\n` +
              `📏 ${Number(o.distance_km || 0).toFixed(2)} km | 💰 ${Number(o.price_azn || 0).toFixed(2)} AZN\n` +
              `⭐ Driver rating: ${Number((db.prepare('SELECT COALESCE(avg_rating,0) a FROM drivers WHERE tg_id=?').get(o.driver_id||0)?.a)||0).toFixed(2)}`,
          });
        }
        return res.sendStatus(200);
      }

      // Admin drivers list
      if (text === "/admin_drivers") {
        if (!isAdmin(tgId)) return res.sendStatus(200);
        const ds = db.prepare(
          `SELECT tg_id, full_name, phone, car, plate, is_online, avg_rating, rating_count, offers_total, offers_accepted, updated_at
           FROM drivers
           WHERE is_approved=1
           ORDER BY is_online DESC, updated_at DESC
           LIMIT 50`
        ).all();
        if (!ds.length) {
          await tg("sendMessage", { chat_id: tgId, text: "Sürücü yoxdur." });
          return res.sendStatus(200);
        }
        let out = "🚖 Sürücülər (top 50)\n\n";
        for (const d of ds) {
          const total = Number(d.offers_total || 0);
          const acc = Number(d.offers_accepted || 0);
          const ar = total ? Math.round((acc / total) * 100) : 0;
          out += `${d.is_online ? "🟢" : "⚪"} ${d.full_name || "-"} | ${d.phone || "-"}\n`;
          out += `ID:${d.tg_id} | ${d.car || "-"} | ${d.plate || "-"}\n`;
          out += `⭐ ${Number(d.avg_rating||0).toFixed(2)} (${Number(d.rating_count||0)}) | ✅Accept ${ar}%\n\n`;
        }
        await tg("sendMessage", { chat_id: tgId, text: out });
        return res.sendStatus(200);
      }

      // Admin order details
      if (typeof text === "string" && text.startsWith("/admin_order")) {
        if (!isAdmin(tgId)) return res.sendStatus(200);
        const parts = text.trim().split(/\s+/);
        const id = Number(parts[1]);
        if (!id) {
          await tg("sendMessage", { chat_id: tgId, text: "İstifadə: /admin_order 12" });
          return res.sendStatus(200);
        }
        const o = db.prepare(`SELECT * FROM orders WHERE id=?`).get(id);
        if (!o) {
          await tg("sendMessage", { chat_id: tgId, text: "Sifariş tapılmadı." });
          return res.sendStatus(200);
        }
        const pickupWaze = (o.pickup_lat && o.pickup_lon) ? wazeLinkByLL(o.pickup_lat, o.pickup_lon) : "-";
        let dropWaze = "-";
        if (o.drop_lat && o.drop_lon) dropWaze = wazeLinkByLL(o.drop_lat, o.drop_lon);
        else if (o.drop_text) dropWaze = wazeLinkByQuery(o.drop_text);
        await tg("sendMessage", {
          chat_id: tgId,
          text:
            `#${o.id} | ${o.status}\n` +
            `👤 customer: ${o.customer_id}\n` +
            `🚖 driver: ${o.driver_id || "-"}\n` +
            `📏 ${Number(o.distance_km || 0).toFixed(2)} km\n` +
            `💰 ${Number(o.price_azn || 0).toFixed(2)} AZN\n` +
            `⏱️ ETA sec: ${Number(o.eta_sec || 0)}\n` +
            `🧭 Pickup: ${pickupWaze}\n` +
            `🧭 Drop: ${dropWaze}`,
        });
        return res.sendStatus(200);
      }

      // location messages
      if (m.location) {
        const lat = m.location.latitude;
        const lon = m.location.longitude;

        // update driver last location if driver exists
        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        if (d) {
          db.prepare(`UPDATE drivers SET last_lat=?, last_lon=?, updated_at=? WHERE tg_id=?`).run(lat, lon, now(), tgId);

          // Push live map + ETA (throttled) to active customer
          const o = db.prepare(
            `SELECT id, customer_id, status, pickup_lat, pickup_lon, drop_lat, drop_lon, COALESCE(last_eta_push_ts,0) as last_eta_push_ts
             FROM orders WHERE driver_id=? AND status IN ('accepted','arrived','in_trip') ORDER BY updated_at DESC LIMIT 1`
          ).get(tgId);

          if (o) {
            const ts = now();
            if (ts - Number(o.last_eta_push_ts || 0) >= 120) {
              // determine target
              let targetLat = o.pickup_lat, targetLon = o.pickup_lon, title = "Pickup";
              if (o.status === "in_trip" && o.drop_lat && o.drop_lon) {
                targetLat = o.drop_lat; targetLon = o.drop_lon; title = "Drop";
              }
              const route = (targetLat && targetLon) ? await getRoute(lat, lon, targetLat, targetLon) : { sec: 0, km: 0 };
              const etaMin = route.sec ? Math.max(1, Math.ceil(route.sec/60)) : 0;

              db.prepare(`UPDATE orders SET eta_sec=?, last_eta_push_ts=?, updated_at=? WHERE id=?`).run(route.sec || 0, ts, ts, o.id);

              await tg("sendMessage", {
                chat_id: o.customer_id,
                text: `📍 Canlı xəritə:\n${gmapsLL(lat, lon)}\n⏱️ ETA yeniləndi (${title}): ${etaMin} dəq`,
              });
            }
          }
        }

        // customer session handling
        const sess = getSession(tgId);

        // customer pickup
        if (sess && sess.step === "customer_wait_pickup") {
          setSession(tgId, "customer_wait_drop", { tmp_pickup_lat: lat, tmp_pickup_lon: lon });
          await tg("sendMessage", { chat_id: tgId, text: t(lang, "sendDrop"), reply_markup: locKb() });
          return res.sendStatus(200);
        }

        // customer drop (as location) -> create order
        if (sess && sess.step === "customer_wait_drop") {
          const pickupLat = sess.tmp_pickup_lat;
          const pickupLon = sess.tmp_pickup_lon;

          const route = await getRoute(pickupLat, pickupLon, lat, lon);
          const distanceKm = route.km;
          const price = calcPrice(distanceKm);

          const info = db.prepare(
            `INSERT INTO orders(customer_id, status, pickup_lat, pickup_lon, drop_lat, drop_lon, drop_text, distance_km, price_azn, eta_sec, last_eta_push_ts, created_at, updated_at, rated)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(tgId, "searching", pickupLat, pickupLon, lat, lon, sess.tmp_drop_text ?? null, distanceKm, price, 0, 0, now(), now(), 0);

          const orderId = info.lastInsertRowid;
          clearSession(tgId);

          await tg("sendMessage", { chat_id: tgId, text: t(lang, "orderCreated", orderId, distanceKm, price), reply_markup: mainKb(lang) });

          // AI dispatch selection
          const candidates = getCandidateDriversAI(pickupLat, pickupLon, OFFER_DRIVERS);
          if (!candidates.length) {
            db.prepare(`UPDATE orders SET status='no_driver', updated_at=? WHERE id=?`).run(now(), orderId);
            await tg("sendMessage", { chat_id: tgId, text: t(lang, "noDriver") });
            return res.sendStatus(200);
          }

          const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);

          for (const c of candidates) {
            db.prepare(`INSERT INTO offers(order_id, driver_id, status, created_at, updated_at) VALUES(?,?,?,?,?)`).run(orderId, c.tg_id, "offered", now(), now());
            // offer stat counts as "offered" when sent
            ensureDriverStats(c.tg_id);
            db.prepare(`UPDATE drivers SET offers_total=COALESCE(offers_total,0)+1, updated_at=? WHERE tg_id=?`).run(now(), c.tg_id);

            await sendDriverOffer(c.tg_id, order);
          }

          return res.sendStatus(200);
        }

        return res.sendStatus(200);
      }

      // customer: call taxi
      if (text === t(lang, "callTaxi") || text === "🚕 Taksi çağır") {
        setSession(tgId, "customer_wait_pickup");
        await tg("sendMessage", { chat_id: tgId, text: t(lang, "sendPickup"), reply_markup: locKb() });
        return res.sendStatus(200);
      }

      // driver panel
      if (text === t(lang, "driverPanel") || text === "🚖 Sürücü paneli") {
        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        const isOnline = d ? !!d.is_online : false;
        const avg = Number(d?.avg_rating || 0).toFixed(2);
        const rc = Number(d?.rating_count || 0);
        await tg("sendMessage", {
          chat_id: tgId,
          text:
            "🚖 Sürücü paneli\n\n" +
            (d ? `Təsdiq: ${d.is_approved ? "✅" : "⏳"}\nOnline: ${isOnline ? "🟢" : "⚪"}\n⭐ Reytinq: ${avg} (${rc})` : "Sən hələ qeydiyyatdan keçməmisən."),
          reply_markup: driverKb(isOnline),
        });
        return res.sendStatus(200);
      }

      // driver registration
      if (text === "📝 Qeydiyyat") {
        db.prepare(
          `INSERT INTO drivers(tg_id, is_approved, is_online, updated_at, avg_rating, rating_count, offers_total, offers_accepted)
           VALUES(?,?,?,?,0,0,0,0)
           ON CONFLICT(tg_id) DO UPDATE SET tg_id=excluded.tg_id, updated_at=excluded.updated_at`
        ).run(tgId, 0, 0, now());

        setSession(tgId, "driver_reg_name");
        await tg("sendMessage", { chat_id: tgId, text: "Ad Soyad yaz:", reply_markup: { remove_keyboard: true } });
        return res.sendStatus(200);
      }

      // online toggle
      if (text === "🟢 Online" || text === "⚪ Offline") {
        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        if (!d) {
          await tg("sendMessage", { chat_id: tgId, text: t(lang, "needRegister") });
          return res.sendStatus(200);
        }
        if (!d.is_approved) {
          await tg("sendMessage", { chat_id: tgId, text: t(lang, "needApprove") });
          return res.sendStatus(200);
        }

        const newState = d.is_online ? 0 : 1;
        db.prepare(`UPDATE drivers SET is_online=?, updated_at=? WHERE tg_id=?`).run(newState, now(), tgId);

        if (newState === 1) {
          await tg("sendMessage", { chat_id: tgId, text: t(lang, "onlineAskLoc"), reply_markup: locKb() });
        } else {
          await tg("sendMessage", { chat_id: tgId, text: "⚪ Offline oldun.", reply_markup: driverKb(false) });
        }
        return res.sendStatus(200);
      }

      // driver registration steps
      const sess = getSession(tgId);

      if (sess && sess.step === "driver_reg_name" && typeof text === "string") {
        db.prepare(`UPDATE drivers SET full_name=?, updated_at=? WHERE tg_id=?`).run(text.trim(), now(), tgId);
        setSession(tgId, "driver_reg_phone");
        await tg("sendMessage", { chat_id: tgId, text: "Telefon nömrəni yaz:" });
        return res.sendStatus(200);
      }

      if (sess && sess.step === "driver_reg_phone" && typeof text === "string") {
        db.prepare(`UPDATE drivers SET phone=?, updated_at=? WHERE tg_id=?`).run(text.trim(), now(), tgId);
        setSession(tgId, "driver_reg_car");
        await tg("sendMessage", { chat_id: tgId, text: "Maşın (məs: Prius 2016) yaz:" });
        return res.sendStatus(200);
      }

      if (sess && sess.step === "driver_reg_car" && typeof text === "string") {
        db.prepare(`UPDATE drivers SET car=?, updated_at=? WHERE tg_id=?`).run(text.trim(), now(), tgId);
        setSession(tgId, "driver_reg_plate");
        await tg("sendMessage", { chat_id: tgId, text: "Dövlət nömrəsi yaz:" });
        return res.sendStatus(200);
      }

      if (sess && sess.step === "driver_reg_plate" && typeof text === "string") {
        db.prepare(`UPDATE drivers SET plate=?, is_online=0, updated_at=? WHERE tg_id=?`).run(text.trim(), now(), tgId);
        clearSession(tgId);

        await tg("sendMessage", { chat_id: tgId, text: t(lang, "driverAwaitApprove"), reply_markup: driverKb(false) });

        // notify admins
        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        for (const adminId of ADMIN_IDS) {
          await tg("sendMessage", {
            chat_id: adminId,
            text: `⏳ Yeni sürücü qeydiyyatı\n👤 ${d.full_name}\n📞 ${d.phone}\n🚗 ${d.car}\n🔢 ${d.plate}\nID: ${d.tg_id}`,
            reply_markup: { inline_keyboard: [[{ text: "✅ Təsdiq et", callback_data: `appr:${d.tg_id}` }, { text: "❌ Rədd et", callback_data: `rejdrv:${d.tg_id}` }]] },
          });
        }
        return res.sendStatus(200);
      }

      // customer drop as TEXT (optional)
      if (sess && sess.step === "customer_wait_drop" && typeof text === "string" && text.trim().length) {
        setSession(tgId, "customer_wait_drop", { tmp_drop_text: text.trim() });
        await tg("sendMessage", {
          chat_id: tgId,
          text: "✅ Ünvan qəbul edildi.\nİndi də təyinat lokasiyanı göndər ki, məsafə və qiymət dəqiq hesablansın.",
          reply_markup: locKb(),
        });
        return res.sendStatus(200);
      }

      // fallback show menu
      if (typeof text === "string" && text.trim().length) {
        await tg("sendMessage", { chat_id: tgId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
