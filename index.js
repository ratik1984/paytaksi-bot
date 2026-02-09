/**
 * PayTaksi Bot (Telegram) – RESTORE + Destination Preview Confirm (Option #1)
 *
 * ✅ Customer: Call taxi -> send pickup location -> type destination OR send destination location
 * ✅ Destination TEXT -> Geocode (Nominatim) -> preview (Maps/Waze) -> Confirm ✅ / Retry ❌
 * ✅ Price: 3.50 AZN up to 3 km; after 3 km, each +1 km => +0.40 AZN (ceil)
 * ✅ Dispatch: sends offer to nearest online approved drivers (batch size OFFER_DRIVERS)
 * ✅ Driver: accept/reject
 * ✅ Driver: statuses (Arrived/Started/Finished) for active order
 * ✅ Customer: live driver map link + ETA; auto ETA push every 2 minutes
 * ✅ Driver nav preference (Waze / Google Maps)
 * ✅ /id command
 *
 * ENV (Render):
 * - BOT_TOKEN=xxxx
 * - WEBHOOK_SECRET=your_secret_path (e.g. paytaksi_bot)
 * - ADMIN_IDS=1326729201,....
 * - OFFER_DRIVERS=5
 * - ETA_PUSH_SEC=120   (optional, default 120)
 *
 * Webhook URL:
 *   https://<your-render-app>.onrender.com/tg/<WEBHOOK_SECRET>
 */

const express = require("express");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));
const OFFER_DRIVERS = Number(process.env.OFFER_DRIVERS || 5);
const ETA_PUSH_SEC = Number(process.env.ETA_PUSH_SEC || 120);

if (!BOT_TOKEN) console.error("❌ BOT_TOKEN missing");
if (!WEBHOOK_SECRET) console.error("❌ WEBHOOK_SECRET missing");

const db = new Database("paytaksi.sqlite");
db.pragma("journal_mode = WAL");

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

// ---------- DB ----------
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
  tmp_drop_display TEXT,
  tmp_customer_phone TEXT,
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
  nav_pref TEXT DEFAULT 'waze',
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  driver_id INTEGER,
  status TEXT, -- searching/accepted/arrived/started/finished/canceled/no_driver
  pickup_lat REAL,
  pickup_lon REAL,
  drop_lat REAL,
  drop_lon REAL,
  drop_text TEXT,
  distance_km REAL,
  eta_sec INTEGER,
  price_azn REAL,
  customer_phone TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  last_eta_push_ts INTEGER DEFAULT 0,
  rated INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  driver_id INTEGER,
  status TEXT, -- offered/accepted/rejected/expired
  created_at INTEGER,
  updated_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS driver_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  driver_id INTEGER,
  customer_id INTEGER,
  stars INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS geocode_cache (
  q TEXT PRIMARY KEY,
  lat REAL,
  lon REAL,
  display_name TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  level TEXT,
  msg TEXT
);
`);

function log(level, msg) {
  try {
    db.prepare(`INSERT INTO logs(ts, level, msg) VALUES(?,?,?)`).run(now(), level, String(msg).slice(0, 2000));
  } catch {}
}

function safeAlter(sql) {
  try { db.exec(sql); } catch (_) {}
}
safeAlter(`ALTER TABLE drivers ADD COLUMN nav_pref TEXT`);
safeAlter(`ALTER TABLE orders ADD COLUMN customer_phone TEXT`);
safeAlter(`ALTER TABLE offers ADD COLUMN expires_at INTEGER`);
safeAlter(`ALTER TABLE sessions ADD COLUMN tmp_drop_display TEXT`);
safeAlter(`ALTER TABLE sessions ADD COLUMN tmp_customer_phone TEXT`);

// ---------- Helpers ----------
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
      `INSERT INTO sessions(tg_id, step, tmp_pickup_lat, tmp_pickup_lon, tmp_drop_lat, tmp_drop_lon, tmp_drop_text, tmp_drop_display, tmp_customer_phone, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      tgId,
      step,
      patch.tmp_pickup_lat ?? null,
      patch.tmp_pickup_lon ?? null,
      patch.tmp_drop_lat ?? null,
      patch.tmp_drop_lon ?? null,
      patch.tmp_drop_text ?? null,
      patch.tmp_drop_display ?? null,
      patch.tmp_customer_phone ?? null,
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
        tmp_drop_display=COALESCE(?, tmp_drop_display),
        tmp_customer_phone=COALESCE(?, tmp_customer_phone),
        updated_at=? WHERE tg_id=?`
    ).run(
      step,
      patch.tmp_pickup_lat ?? null,
      patch.tmp_pickup_lon ?? null,
      patch.tmp_drop_lat ?? null,
      patch.tmp_drop_lon ?? null,
      patch.tmp_drop_text ?? null,
      patch.tmp_drop_display ?? null,
      patch.tmp_customer_phone ?? null,
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

async function getRoute(pLat, pLon, dLat, dLon) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${pLon},${pLat};${dLon},${dLat}?overview=false`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j?.routes?.[0]) {
      return { km: j.routes[0].distance / 1000, sec: j.routes[0].duration };
    }
  } catch (e) {
    log("warn", "OSRM route error: " + (e?.message || e));
  }
  const km = haversineKm(pLat, pLon, dLat, dLon);
  const sec = Math.max(60, Math.round((km / 35) * 3600));
  return { km, sec };
}

function calcPrice(distanceKm) {
  const km = Math.max(0, Number(distanceKm) || 0);
  if (km <= 3) return 3.5;
  return +(3.5 + Math.ceil(km - 3) * 0.4).toFixed(2);
}

// Map links
function wazeLL(lat, lon) {
  return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
}
function wazeQ(q) {
  return `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
}
function gmapsLL(lat, lon) {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}
function gmapsQ(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// Phone normalize for tel:
function normalizeTel(p) {
  if (!p) return null;
  let s = String(p).trim().replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) {
    if (s.startsWith("994")) s = "+" + s;
    else if (s.startsWith("0")) s = "+994" + s.slice(1);
    else s = "+994" + s;
  }
  return s;
}

// Geocode (Nominatim) + cache
function normQuery(q) {
  return (q || "").trim().replace(/\s+/g, " ").toLowerCase();
}
async function geocodePlace(qRaw) {
  const q = normQuery(qRaw);
  if (!q || q.length < 3) return null;

  try {
    const cached = db.prepare(`SELECT lat, lon, display_name, updated_at FROM geocode_cache WHERE q=?`).get(q);
    if (cached && (now() - Number(cached.updated_at || 0) < 30 * 86400)) {
      return { lat: Number(cached.lat), lon: Number(cached.lon), display_name: cached.display_name || qRaw, cached: true };
    }
  } catch {}

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=az&q=${encodeURIComponent(qRaw)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6500);
    const r = await fetch(url, {
      headers: {
        "user-agent": "PayTaksiBot/1.0",
        "accept-language": "az,en;q=0.8,ru;q=0.6",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    const first = Array.isArray(j) ? j[0] : null;
    if (!first?.lat || !first?.lon) return null;
    const lat = Number(first.lat);
    const lon = Number(first.lon);
    const dn = first.display_name || qRaw;

    try {
      db.prepare(
        `INSERT INTO geocode_cache(q, lat, lon, display_name, updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(q) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, display_name=excluded.display_name, updated_at=excluded.updated_at`
      ).run(q, lat, lon, dn, now());
    } catch {}

    return { lat, lon, display_name: dn, cached: false };
  } catch (e) {
    log("warn", "geocode error: " + (e?.message || e));
    return null;
  }
}

// UI
const STR = {
  az: {
    welcome: "Xoş gəldin!\nAşağıdan seçim et:",
    callTaxi: "🚕 Taksi çağır",
    driverPanel: "🚖 Sürücü paneli",
    navChoose: "🧭 Navi seçimi",
    reg: "📝 Qeydiyyat",
    back: "⬅️ Geri",
    sendPickup: "📍 Zəhmət olmasa götürülmə lokasiyanı göndər.",
    sendDrop: "🎯 Haraya gedirsən?\n✅ Lokasiya göndər\n✅ Ya da yerin adını/ünvanı yaz (məs: 28 Mall)",
    geocodeFail: "❌ Ünvanı tapa bilmədim. Zəhmət olmasa lokasiya göndər.",
    previewAsk: "✅ Bu ünvandır?\nAşağıdakı linklərlə baxıb təsdiqlə:",
    confirmYes: "✅ Bəli (təsdiq)",
    confirmNo: "❌ Yenidən yaz",
    noDriver: "❌ Hal-hazırda online sürücü tapılmadı. Sonra yenə yoxla.",
    orderCreated: (id, km, price, etaMin) =>
      `✅ Sifariş yaradıldı (#${id})\n📏 Məsafə: ${km.toFixed(2)} km\n⏱️ ETA: ${etaMin} dəq\n💰 Qiymət: ${price.toFixed(2)} AZN (nağd)\n\n📨 Sifariş sürücülərə göndərildi.`,
    driverOfferTitle: (id, km, price, etaMin) =>
      `🔔 Yeni sifariş (#${id})\n📏 ${km.toFixed(2)} km\n⏱️ ${etaMin} dəq\n💰 ${price.toFixed(2)} AZN (nağd)`,
    driverAcceptedToDriver: (id) => `✅ Sifarişi qəbul etdin. (#${id})`,
    driverAcceptedToCustomer: (id, etaMin, map) =>
      `✅ Sürücü tapıldı!\nSifariş #${id}\n\n⏱️ ETA: ${etaMin} dəq\n📍 Canlı xəritə: ${map}\n\nSürücü yola çıxır.`,
    orderAlreadyTaken: "⚠️ Bu sifariş artıq başqa sürücü tərəfindən götürüldü.",
    driverRejected: "❌ Sifarişi rədd etdin.",
    onlineAskLoc: "🟢 Online oldun. Lokasiyanı göndər ki, yaxın sifarişlər gəlsin.",
    needRegister: "Əvvəl 📝 Qeydiyyat edin.",
    needApprove: "Admin təsdiqi gözlənilir.",
    regStart: "📝 Qeydiyyat üçün bu formatda yaz:\nAd Soyad | Telefon | Maşın | Nömrə\nMəs: Ratik Quliyev | 0501234567 | Priora | 10-AA-123",
    regSent: "✅ Qeydiyyat göndərildi. Admin təsdiq edəndən sonra Online ola biləcəksən.",
    progFmt: (kmLeft, minLeft, map) => `📍 Sürücü yaxınlaşır\n⏱️ Təxmini qalıb: ${kmLeft} km / ${minLeft} dəq\n🗺️ Canlı xəritə: ${map}`,
  },
};
function t(lang, key, ...args) {
  const L = STR[lang] ? lang : "az";
  const v = STR[L][key];
  return typeof v === "function" ? v(...args) : v;
}
function mainKb(lang) {
  return { keyboard: [[{ text: t(lang, "callTaxi") }], [{ text: t(lang, "driverPanel") }]], resize_keyboard: true };
}
function locKb(lang) {
  return { keyboard: [[{ text: "📍 Lokasiya göndər", request_location: true }], [{ text: t(lang, "back") }]], resize_keyboard: true };
}
function driverKb(lang, isOnline) {
  return {
    keyboard: [
      [{ text: isOnline ? "🟢 Online" : "⚪ Offline" }],
      [{ text: t(lang, "reg") }],
      [{ text: t(lang, "navChoose") }],
      [{ text: t(lang, "back") }],
    ],
    resize_keyboard: true,
  };
}
function navPrefKb(current) {
  const cur = (current || "waze").toLowerCase();
  return {
    inline_keyboard: [
      [{ text: (cur === "waze" ? "✅ " : "") + "Waze", callback_data: "navpref:waze" }],
      [{ text: (cur === "maps" ? "✅ " : "") + "Google Maps", callback_data: "navpref:maps" }],
    ],
  };
}
function confirmDestKb() {
  return {
    inline_keyboard: [
      [{ text: STR.az.confirmYes, callback_data: "dest_ok" }],
      [{ text: STR.az.confirmNo, callback_data: "dest_no" }],
    ],
  };
}
function offerDecisionKb(orderId) {
  return {
    inline_keyboard: [
      [{ text: "✅ Qəbul et", callback_data: `accept:${orderId}` }],
      [{ text: "❌ Rədd et", callback_data: `reject:${orderId}` }],
    ],
  };
}
function driverStatusKb(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "📍 Gəldim", callback_data: `arrived:${orderId}` },
        { text: "▶️ Başladım", callback_data: `started:${orderId}` },
      ],
      [{ text: "🏁 Bitirdim", callback_data: `finished:${orderId}` }],
    ],
  };
}
function navButtonsPickupDrop(pickup, drop) {
  return {
    inline_keyboard: [
      [
        { text: "🧭 Pickup Waze", url: pickup.waze },
        { text: "🗺️ Pickup Maps", url: pickup.maps },
      ],
      [
        { text: "🧭 Drop Waze", url: drop.waze },
        { text: "🗺️ Drop Maps", url: drop.maps },
      ],
    ],
  };
}

// ---------- Business logic ----------
function getActiveOrderByCustomer(cid) {
  return db.prepare(`SELECT * FROM orders WHERE customer_id=? AND status IN ('searching','accepted','arrived','started') ORDER BY id DESC LIMIT 1`).get(cid);
}
function getActiveOrderByDriver(did) {
  return db.prepare(`SELECT * FROM orders WHERE driver_id=? AND status IN ('accepted','arrived','started') ORDER BY id DESC LIMIT 1`).get(did);
}

async function createOrderFromSession(tgId, sess, dropLat, dropLon, dropText, dropDisplay) {
  const pLat = Number(sess.tmp_pickup_lat);
  const pLon = Number(sess.tmp_pickup_lon);
  const route = await getRoute(pLat, pLon, dropLat, dropLon);
  const km = route.km;
  const sec = route.sec;
  const price = calcPrice(km);

  const etaMin = Math.max(1, Math.ceil(sec / 60));

  const info = db.prepare(
    `INSERT INTO orders(customer_id, status, pickup_lat, pickup_lon, drop_lat, drop_lon, drop_text, distance_km, eta_sec, price_azn, customer_phone, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    tgId,
    "searching",
    pLat,
    pLon,
    dropLat,
    dropLon,
    dropText || null,
    km,
    Math.round(sec),
    price,
    sess.tmp_customer_phone || null,
    now(),
    now()
  );
  const orderId = info.lastInsertRowid;

  clearSession(tgId);

  await tg("sendMessage", {
    chat_id: tgId,
    text: t("az", "orderCreated", orderId, km, price, etaMin),
    reply_markup: mainKb("az"),
  });

  await dispatchOrder(orderId);
}

async function dispatchOrder(orderId) {
  const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
  if (!order || order.status !== "searching") return;

  // candidates: approved + online + has location
  const drivers = db.prepare(
    `SELECT tg_id, last_lat, last_lon, nav_pref FROM drivers
     WHERE is_approved=1 AND is_online=1
       AND last_lat IS NOT NULL AND last_lon IS NOT NULL`
  ).all();

  // exclude drivers already offered
  const sent = db.prepare(`SELECT driver_id FROM offers WHERE order_id=?`).all(orderId).map((x) => x.driver_id);

  const ranked = drivers
    .filter((d) => !sent.includes(d.tg_id))
    .map((d) => ({ ...d, dist: haversineKm(order.pickup_lat, order.pickup_lon, d.last_lat, d.last_lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, OFFER_DRIVERS);

  if (!ranked.length) {
    db.prepare(`UPDATE orders SET status='no_driver', updated_at=? WHERE id=?`).run(now(), orderId);
    await tg("sendMessage", { chat_id: order.customer_id, text: STR.az.noDriver, reply_markup: mainKb("az") });
    return;
  }

  const pickup = {
    waze: wazeLL(order.pickup_lat, order.pickup_lon),
    maps: gmapsLL(order.pickup_lat, order.pickup_lon),
  };
  let drop = { waze: "-", maps: "-" };
  if (order.drop_lat && order.drop_lon) {
    drop = { waze: wazeLL(order.drop_lat, order.drop_lon), maps: gmapsLL(order.drop_lat, order.drop_lon) };
  } else if (order.drop_text) {
    drop = { waze: wazeQ(order.drop_text), maps: gmapsQ(order.drop_text) };
  }

  const etaMin = Math.max(1, Math.ceil(Number(order.eta_sec || 0) / 60));
  const title = STR.az.driverOfferTitle(orderId, Number(order.distance_km || 0), Number(order.price_azn || 0), etaMin);

  for (const d of ranked) {
    db.prepare(
      `INSERT INTO offers(order_id, driver_id, status, created_at, updated_at, expires_at)
       VALUES(?,?,?,?,?,?)`
    ).run(orderId, d.tg_id, "offered", now(), now(), now() + 30);

    // 🔔 driver notification (sound)
    await tg("sendMessage", {
      chat_id: d.tg_id,
      text: title,
      disable_notification: false,
      reply_markup: navButtonsPickupDrop(pickup, drop),
    });

    await tg("sendMessage", {
      chat_id: d.tg_id,
      text: "Qərar ver:",
      reply_markup: offerDecisionKb(orderId),
    });
  }
}

// ETA push worker (every 10 sec checks; pushes at most every ETA_PUSH_SEC per order)
async function etaWorker() {
  const ts = now();
  const active = db
    .prepare(`SELECT * FROM orders WHERE status IN ('accepted','arrived','started')`)
    .all();

  for (const o of active) {
    if (Number(o.last_eta_push_ts || 0) > ts - ETA_PUSH_SEC) continue;
    if (!o.driver_id) continue;

    const d = db.prepare(`SELECT last_lat, last_lon FROM drivers WHERE tg_id=?`).get(o.driver_id);
    if (!d?.last_lat || !d?.last_lon) continue;

    // target: pickup if not arrived yet; else drop
    const targetLat = o.status === "accepted" ? o.pickup_lat : o.drop_lat;
    const targetLon = o.status === "accepted" ? o.pickup_lon : o.drop_lon;
    if (targetLat == null || targetLon == null) continue;

    const route = await getRoute(d.last_lat, d.last_lon, targetLat, targetLon);
    const kmLeft = route.km;
    const minLeft = Math.max(1, Math.ceil(route.sec / 60));
    const map = gmapsLL(d.last_lat, d.last_lon);

    await tg("sendMessage", { chat_id: o.customer_id, text: STR.az.progFmt(kmLeft.toFixed(1), minLeft, map) });

    db.prepare(`UPDATE orders SET last_eta_push_ts=?, updated_at=? WHERE id=?`).run(ts, ts, o.id);
  }

  // offer timeout -> redispatch
  const exp = db.prepare(
    `SELECT id, order_id, driver_id FROM offers
     WHERE status='offered' AND expires_at IS NOT NULL AND expires_at <= ?`
  ).all(ts);

  for (const ofr of exp) {
    db.prepare(`UPDATE offers SET status='expired', updated_at=? WHERE id=?`).run(ts, ofr.id);
    const ord = db.prepare(`SELECT id, status FROM orders WHERE id=?`).get(ofr.order_id);
    if (ord && ord.status === "searching") {
      await dispatchOrder(ord.id);
    }
  }
}
setInterval(() => etaWorker().catch((e) => log("warn", "etaWorker: " + (e?.message || e))), 10000);

// ---------- Web routes ----------
app.get("/", (req, res) => res.send("PayTaksi bot running 🚕"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post(`/tg/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    // Callback query
    if (update.callback_query) {
      const cq = update.callback_query;
      const tgId = cq.from.id;
      const data = cq.data || "";
      upsertUser(tgId);
      await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});

      // nav pref set
      if (data.startsWith("navpref:")) {
        const pref = data.split(":")[1] === "maps" ? "maps" : "waze";
        db.prepare(
          `INSERT INTO drivers(tg_id, nav_pref, updated_at) VALUES(?,?,?)
           ON CONFLICT(tg_id) DO UPDATE SET nav_pref=excluded.nav_pref, updated_at=excluded.updated_at`
        ).run(tgId, pref, now());
        await tg("sendMessage", { chat_id: tgId, text: `✅ Navi seçimi: ${pref === "maps" ? "Google Maps" : "Waze"}` });
        return res.sendStatus(200);
      }

      // Destination confirm
      if (data === "dest_ok" || data === "dest_no") {
        const sess = getSession(tgId);
        if (!sess) return res.sendStatus(200);

        if (data === "dest_no") {
          setSession(tgId, "customer_wait_drop_text", {});
          await tg("sendMessage", { chat_id: tgId, text: STR.az.sendDrop, reply_markup: locKb("az") });
          return res.sendStatus(200);
        }

        // confirm YES -> create order using tmp_drop_lat/lon
        if (sess.tmp_drop_lat != null && sess.tmp_drop_lon != null) {
          await createOrderFromSession(
            tgId,
            sess,
            Number(sess.tmp_drop_lat),
            Number(sess.tmp_drop_lon),
            sess.tmp_drop_text,
            sess.tmp_drop_display
          );
        } else {
          await tg("sendMessage", { chat_id: tgId, text: STR.az.geocodeFail, reply_markup: locKb("az") });
        }
        return res.sendStatus(200);
      }

      // Driver accept/reject
      if (data.startsWith("accept:") || data.startsWith("reject:")) {
        const parts = data.split(":");
        const action = parts[0];
        const orderId = Number(parts[1]);

        const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
        if (!order || order.status !== "searching") {
          await tg("sendMessage", { chat_id: tgId, text: STR.az.orderAlreadyTaken });
          return res.sendStatus(200);
        }

        // validate driver
        const drv = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        if (!drv || !drv.is_approved) {
          await tg("sendMessage", { chat_id: tgId, text: STR.az.needApprove });
          return res.sendStatus(200);
        }

        if (action === "reject") {
          db.prepare(`UPDATE offers SET status='rejected', updated_at=? WHERE order_id=? AND driver_id=? AND status='offered'`)
            .run(now(), orderId, tgId);
          await tg("sendMessage", { chat_id: tgId, text: STR.az.driverRejected });
          return res.sendStatus(200);
        }

        // accept -> atomic: set order driver if still searching
        const updated = db
          .prepare(`UPDATE orders SET status='accepted', driver_id=?, updated_at=? WHERE id=? AND status='searching'`)
          .run(tgId, now(), orderId);

        if (updated.changes === 0) {
          await tg("sendMessage", { chat_id: tgId, text: STR.az.orderAlreadyTaken });
          return res.sendStatus(200);
        }

        db.prepare(`UPDATE offers SET status='accepted', updated_at=? WHERE order_id=? AND driver_id=?`).run(now(), orderId, tgId);
        db.prepare(`UPDATE offers SET status='expired', updated_at=? WHERE order_id=? AND driver_id<>? AND status='offered'`).run(now(), orderId, tgId);

        await tg("sendMessage", { chat_id: tgId, text: STR.az.driverAcceptedToDriver(orderId), reply_markup: driverStatusKb(orderId) });

        // driver "call customer" button if phone exists
        if (order.customer_phone) {
          const tel = normalizeTel(order.customer_phone);
          if (tel) {
            await tg("sendMessage", {
              chat_id: tgId,
              text: "📞 Müştəriyə zəng et:",
              reply_markup: { inline_keyboard: [[{ text: "📞 Zəng et", url: `tel:${tel}` }]] },
            });
          }
        }

        // notify customer with live map + ETA based on driver->pickup
        const d = db.prepare(`SELECT last_lat,last_lon FROM drivers WHERE tg_id=?`).get(tgId);
        let etaMin = Math.max(1, Math.ceil(Number(order.eta_sec || 0) / 60));
        let map = "";
        if (d?.last_lat && d?.last_lon) {
          const route = await getRoute(d.last_lat, d.last_lon, order.pickup_lat, order.pickup_lon);
          etaMin = Math.max(1, Math.ceil(route.sec / 60));
          map = gmapsLL(d.last_lat, d.last_lon);
        }

        await tg("sendMessage", { chat_id: order.customer_id, text: STR.az.driverAcceptedToCustomer(orderId, etaMin, map) });

        return res.sendStatus(200);
      }

      // Driver status updates
      if (data.startsWith("arrived:") || data.startsWith("started:") || data.startsWith("finished:")) {
        const [act, idStr] = data.split(":");
        const orderId = Number(idStr);
        const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
        if (!order || order.driver_id !== tgId) return res.sendStatus(200);

        let newStatus = null;
        if (act === "arrived") newStatus = "arrived";
        if (act === "started") newStatus = "started";
        if (act === "finished") newStatus = "finished";

        if (!newStatus) return res.sendStatus(200);

        db.prepare(`UPDATE orders SET status=?, updated_at=? WHERE id=?`).run(newStatus, now(), orderId);

        await tg("sendMessage", { chat_id: tgId, text: `✅ Status: ${newStatus}` });
        await tg("sendMessage", { chat_id: order.customer_id, text: `ℹ️ Sifariş #${orderId} status: ${newStatus}` });

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // Message
    if (update.message) {
      const m = update.message;
      const tgId = m.from.id;
      upsertUser(tgId);
      const user = getUser(tgId) || { lang: "az" };
      const lang = user.lang || "az";
      const text = m.text;

      // /id
      if (text && (text.toLowerCase() === "/id")) {
        await tg("sendMessage", { chat_id: tgId, text: `Sənin Telegram ID: ${tgId}` });
        return res.sendStatus(200);
      }

      // /start
      if (text === "/start") {
        await tg("sendMessage", { chat_id: tgId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
        return res.sendStatus(200);
      }

      // Back
      if (text === t(lang, "back") || text === "⬅️ Geri") {
        clearSession(tgId);
        await tg("sendMessage", { chat_id: tgId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
        return res.sendStatus(200);
      }

      // Driver panel open
      if (text === t(lang, "driverPanel") || text === "🚖 Sürücü paneli") {
        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        const isOnline = d ? !!d.is_online : false;
        const pref = (d?.nav_pref || "waze").toLowerCase();
        await tg("sendMessage", {
          chat_id: tgId,
          text: `🚖 Sürücü paneli\n🧭 Navi: ${pref === "maps" ? "Google Maps" : "Waze"}`,
          reply_markup: driverKb(lang, isOnline),
        });
        return res.sendStatus(200);
      }

      // Nav choose
      if (text === t(lang, "navChoose") || text === "🧭 Navi seçimi" || text === "🧭 Navi seçimi") {
        const d = db.prepare(`SELECT nav_pref FROM drivers WHERE tg_id=?`).get(tgId);
        await tg("sendMessage", { chat_id: tgId, text: "Default navi seç:", reply_markup: navPrefKb(d?.nav_pref || "waze") });
        return res.sendStatus(200);
      }

      // Driver online/offline toggle
      if (text === "🟢 Online" || text === "⚪ Offline") {
        const d = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        if (!d) {
          await tg("sendMessage", { chat_id: tgId, text: STR.az.needRegister, reply_markup: driverKb(lang, false) });
          return res.sendStatus(200);
        }
        if (!d.is_approved) {
          await tg("sendMessage", { chat_id: tgId, text: STR.az.needApprove, reply_markup: driverKb(lang, false) });
          return res.sendStatus(200);
        }
        const makeOnline = text === "🟢 Online";
        db.prepare(`UPDATE drivers SET is_online=?, updated_at=? WHERE tg_id=?`).run(makeOnline ? 1 : 0, now(), tgId);
        if (makeOnline) {
          await tg("sendMessage", { chat_id: tgId, text: STR.az.onlineAskLoc, reply_markup: locKb(lang) });
        } else {
          await tg("sendMessage", { chat_id: tgId, text: "⚪ Offline oldun.", reply_markup: driverKb(lang, false) });
        }
        return res.sendStatus(200);
      }

      // Driver registration
      if (text === t(lang, "reg") || text === "📝 Qeydiyyat") {
        setSession(tgId, "driver_reg", {});
        await tg("sendMessage", { chat_id: tgId, text: STR.az.regStart, reply_markup: { remove_keyboard: true } });
        return res.sendStatus(200);
      }

      // Handle driver reg input
      const sess = getSession(tgId);
      if (sess && sess.step === "driver_reg" && text) {
        const parts = text.split("|").map((s) => s.trim());
        if (parts.length >= 4) {
          const [full_name, phone, car, plate] = parts;
          db.prepare(
            `INSERT INTO drivers(tg_id, full_name, phone, car, plate, is_approved, is_online, updated_at)
             VALUES(?,?,?,?,?,0,0,?)
             ON CONFLICT(tg_id) DO UPDATE SET full_name=excluded.full_name, phone=excluded.phone, car=excluded.car, plate=excluded.plate, updated_at=excluded.updated_at`
          ).run(tgId, full_name, phone, car, plate, now());
          clearSession(tgId);

          // notify admins
          for (const aid of ADMIN_IDS) {
            await tg("sendMessage", {
              chat_id: aid,
              text:
                `🆕 Sürücü qeydiyyatı\n` +
                `ID: ${tgId}\n` +
                `Ad: ${full_name}\n` +
                `Tel: ${phone}\n` +
                `Maşın: ${car}\n` +
                `Nömrə: ${plate}\n\n` +
                `Təsdiq üçün: /approve ${tgId}  |  /reject ${tgId}`,
            }).catch(() => {});
          }

          await tg("sendMessage", { chat_id: tgId, text: STR.az.regSent, reply_markup: driverKb(lang, false) });
          return res.sendStatus(200);
        }
        await tg("sendMessage", { chat_id: tgId, text: "❌ Format səhvdir. Yenə yaz:\nAd Soyad | Telefon | Maşın | Nömrə" });
        return res.sendStatus(200);
      }

      // Admin approve/reject commands
      if (isAdmin(tgId) && text) {
        const m1 = text.match(/^\/approve\s+(\d+)/i);
        const m2 = text.match(/^\/reject\s+(\d+)/i);
        if (m1) {
          const did = Number(m1[1]);
          db.prepare(`UPDATE drivers SET is_approved=1, updated_at=? WHERE tg_id=?`).run(now(), did);
          await tg("sendMessage", { chat_id: did, text: "✅ Admin: təsdiqləndin! İndi Online ola bilərsən." }).catch(() => {});
          await tg("sendMessage", { chat_id: tgId, text: `✅ Approved: ${did}` });
          return res.sendStatus(200);
        }
        if (m2) {
          const did = Number(m2[1]);
          db.prepare(`UPDATE drivers SET is_approved=0, is_online=0, updated_at=? WHERE tg_id=?`).run(now(), did);
          await tg("sendMessage", { chat_id: did, text: "❌ Admin: qeydiyyat rədd edildi." }).catch(() => {});
          await tg("sendMessage", { chat_id: tgId, text: `✅ Rejected: ${did}` });
          return res.sendStatus(200);
        }
      }

      // Location updates
      if (m.location) {
        const lat = m.location.latitude;
        const lon = m.location.longitude;

        // If driver online, store driver location
        const drv = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(tgId);
        if (drv) {
          db.prepare(`UPDATE drivers SET last_lat=?, last_lon=?, updated_at=? WHERE tg_id=?`).run(lat, lon, now(), tgId);
        }

        const sess2 = getSession(tgId);
        if (sess2 && sess2.step === "customer_wait_pickup") {
          setSession(tgId, "customer_wait_drop_text", { tmp_pickup_lat: lat, tmp_pickup_lon: lon });
          await tg("sendMessage", { chat_id: tgId, text: STR.az.sendDrop, reply_markup: locKb(lang) });
          return res.sendStatus(200);
        }

        // Destination location directly
        if (sess2 && sess2.step === "customer_wait_drop_loc") {
          setSession(tgId, "customer_wait_drop_text", { tmp_drop_lat: lat, tmp_drop_lon: lon, tmp_drop_text: null, tmp_drop_display: null });
          // create immediately
          await createOrderFromSession(tgId, getSession(tgId), lat, lon, null, null);
          return res.sendStatus(200);
        }

        return res.sendStatus(200);
      }

      // Customer flow: Call taxi
      if (text === t(lang, "callTaxi") || text === "🚕 Taksi çağır") {
        const active = getActiveOrderByCustomer(tgId);
        if (active) {
          await tg("sendMessage", { chat_id: tgId, text: `ℹ️ Aktiv sifarişin var (#${active.id}) Status: ${active.status}` });
          return res.sendStatus(200);
        }

        setSession(tgId, "customer_wait_pickup", {});
        await tg("sendMessage", { chat_id: tgId, text: STR.az.sendPickup, reply_markup: locKb(lang) });
        return res.sendStatus(200);
      }

      // Customer: handle destination text with preview confirm (Option #1)
      const sess3 = getSession(tgId);
      if (sess3 && sess3.step === "customer_wait_drop_text" && text && text.trim().length) {
        const q = text.trim();

        // allow user to skip and send destination location
        if (q.toLowerCase() === "lokasiya göndər" || q.toLowerCase() === "location") {
          setSession(tgId, "customer_wait_drop_loc", {});
          await tg("sendMessage", { chat_id: tgId, text: "📍 Gediləcək lokasiyanı göndər.", reply_markup: locKb(lang) });
          return res.sendStatus(200);
        }

        const g = await geocodePlace(q);
        if (!g) {
          await tg("sendMessage", { chat_id: tgId, text: STR.az.geocodeFail, reply_markup: locKb(lang) });
          return res.sendStatus(200);
        }

        // store in session and show preview
        setSession(tgId, "customer_wait_drop_confirm", {
          tmp_drop_lat: g.lat,
          tmp_drop_lon: g.lon,
          tmp_drop_text: q,
          tmp_drop_display: g.display_name,
        });

        const maps = gmapsLL(g.lat, g.lon);
        const waze = wazeLL(g.lat, g.lon);

        await tg("sendMessage", {
          chat_id: tgId,
          text: `${STR.az.previewAsk}\n\n📍 ${g.display_name}\n🗺️ Maps: ${maps}\n🧭 Waze: ${waze}`,
          reply_markup: confirmDestKb(),
        });
        return res.sendStatus(200);
      }

      // Default fallback
      await tg("sendMessage", { chat_id: tgId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    log("error", e?.stack || e?.message || String(e));
    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
