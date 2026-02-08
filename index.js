/**
 * PayTaksi Telegram Bot (Render) - ALL-IN-ONE
 * - Webhook: /tg/<WEBHOOK_SECRET>
 * - Customer: pickup location -> destination location -> OSRM distance -> price (3.50 up to 3km, +0.40/km after)
 * - Driver: registration -> admin approval -> online -> receive offers -> accept/reject
 * - Trip statuses: Arrived / Started / Finished / Cancelled (+ customer notifications)
 * - Waze links: pickup + drop
 * - Admin commands:
 *    /admin           -> pending driver approvals
 *    /admin_live      -> last 20 orders
 *    /admin_drivers   -> top 50 approved drivers (online first)
 *    /admin_order <id>-> order details + Waze links
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
`);

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

// OSRM fallback to haversine
async function getDistanceKm(pLat, pLon, dLat, dLon) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${pLon},${pLat};${dLon},${dLat}?overview=false`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j?.routes?.[0]?.distance != null) return j.routes[0].distance / 1000;
  } catch (e) {}
  return haversineKm(pLat, pLon, dLat, dLon);
}

function calcPrice(distanceKm) {
  const km = Math.max(0, Number(distanceKm) || 0);
  if (km <= 3) return 3.5;
  const extraKm = Math.ceil(km - 3);
  return +(3.5 + extraKm * 0.4).toFixed(2);
}

// ---------------- Waze + UI ----------------
function wazeLinkByLL(lat, lon) {
  return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
}
function wazeLinkByQuery(q) {
  return `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
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
      `✅ Sifariş yaradıldı (#${id})\n📏 Məsafə: ${km.toFixed(
        2
      )} km\n💰 Qiymət: ${price.toFixed(2)} AZN (nağd)\n\n📨 Sifariş sürücülərə göndərildi.`,
    driverAcceptedToDriver: (id) => `✅ Sifarişi qəbul etdin. (#${id})`,
    driverAcceptedToCustomer: (id, d) =>
      `✅ Sürücü tapıldı!\nSifariş #${id}\n\n👤 ${d.full_name}\n📞 ${d.phone}\n🚗 ${d.car}\n🔢 ${d.plate}\n\nSürücü yola çıxır.`,
    orderAlreadyTaken: "⚠️ Bu sifariş artıq başqa sürücü tərəfindən götürüldü.",
    driverRejected: "❌ Sifarişi rədd etdin.",
    pendingNone: "Pending sürücü yoxdur.",

    driverArrivedToCustomer: (id) => `📍 Sürücü gəldi. (Sifariş #${id})`,
    tripStartedToCustomer: (id) => `▶️ Sürüş başladı. (Sifariş #${id})`,
    tripFinishedToCustomer: (id, price) =>
      `🏁 Sürüş bitdi. (Sifariş #${id})\n💰 Ödəniləcək: ${Number(price).toFixed(2)} AZN (nağd)`,
    orderCancelledToCustomer: (id) => `❌ Sifariş ləğv edildi. (#${id})`,
    orderCancelledToDriver: (id) => `❌ Sifarişi ləğv etdin. (#${id})`,
  },
};

function t(lang, key, ...args) {
  const L = STR[lang] ? lang : "az";
  const v = STR[L][key];
  return typeof v === "function" ? v(...args) : v;
}

function mainKb(lang) {
  return {
    keyboard: [
      [{ text: t(lang, "callTaxi") }],
      [{ text: t(lang, "driverPanel") }],
    ],
    resize_keyboard: true,
  };
}

function locKb() {
  return {
    keyboard: [
      [{ text: "📍 Lokasiya göndər", request_location: true }],
      [{ text: "⬅️ Geri" }],
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

// ---------------- Driver selection + offering ----------------
function getCandidateDrivers(pLat, pLon, limit = OFFER_DRIVERS) {
  const rows = db
    .prepare(
      `SELECT tg_id, last_lat, last_lon
       FROM drivers
       WHERE is_approved=1 AND is_online=1
         AND last_lat IS NOT NULL AND last_lon IS NOT NULL`
    )
    .all();

  return rows
    .map((d) => ({
      tg_id: d.tg_id,
      dist: haversineKm(pLat, pLon, d.last_lat, d.last_lon),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
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

// ✅ Webhook endpoint MUST exist exactly like this:
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
        await tg("sendMessage", {
          chat_id: fromId,
          text: t(lang, "welcome"),
          reply_markup: mainKb(lang),
        });
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
          await tg("sendMessage", {
            chat_id: driverId,
            text: "✅ Admin səni təsdiqlədi. İndi Online ola bilərsən.",
            reply_markup: driverKb(false),
          });
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

        const offer = db
          .prepare(`SELECT * FROM offers WHERE order_id=? AND driver_id=? AND status='offered'`)
          .get(orderId, fromId);

        if (!offer) {
          await tg("sendMessage", { chat_id: fromId, text: "Bu sifariş sənə aid deyil və ya artıq bağlanıb." });
          return res.sendStatus(200);
        }

        const latest = db.prepare(`SELECT status, driver_id FROM orders WHERE id=?`).get(orderId);

        if (cmd === "reject_order") {
          db.prepare(`UPDATE offers SET status='rejected', updated_at=? WHERE id=?`).run(now(), offer.id);
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
        const locked = db
          .prepare(`UPDATE orders SET status='accepted', driver_id=?, updated_at=? WHERE id=? AND status='searching'`)
          .run(fromId, now(), orderId);

        if (locked.changes === 0) {
          db.prepare(`UPDATE offers SET status='expired', updated_at=? WHERE id=?`).run(now(), offer.id);
          await tg("sendMessage", { chat_id: fromId, text: t("az", "orderAlreadyTaken") });
          return res.sendStatus(200);
        }

        db.prepare(`UPDATE offers SET status='accepted', updated_at=? WHERE id=?`).run(now(), offer.id);
        db.prepare(`UPDATE offers SET status='expired', updated_at=? WHERE order_id=? AND driver_id<>? AND status='offered'`)
          .run(now(), orderId, fromId);

        await tg("sendMessage", { chat_id: fromId, text: t("az", "driverAcceptedToDriver", orderId) });

        const driverFull = db.prepare(`SELECT * FROM drivers WHERE tg_id=?`).get(fromId);
        const customerUser = getUser(order.customer_id) || { lang: "az" };

        await tg("sendMessage", {
          chat_id: order.customer_id,
          text: t(customerUser.lang || "az", "driverAcceptedToCustomer", orderId, driverFull),
        });

        // send pickup + status keyboard to driver
        const pickupWaze = wazeLinkByLL(order.pickup_lat, order.pickup_lon);
        let dropWaze = "-";
        if (order.drop_lat && order.drop_lon) dropWaze = wazeLinkByLL(order.drop_lat, order.drop_lon);
        else if (order.drop_text) dropWaze = wazeLinkByQuery(order.drop_text);

        await tg("sendMessage", {
          chat_id: fromId,
          text: `🧭 Naviqasiya\nPickup: ${pickupWaze}\nDrop: ${dropWaze}`,
        });

        await tg("sendMessage", {
          chat_id: fromId,
          text: `🧩 Sifariş idarəetmə düymələri (#${orderId})`,
          reply_markup: driverStatusKb(orderId),
        });

        return res.sendStatus(200);
      }

      // ---- DRIVER STATUS UPDATES: arrived/starttrip/finish/cancel ----
      if (
        data.startsWith("arrived:") ||
        data.startsWith("starttrip:") ||
        data.startsWith("finish:") ||
        data.startsWith("cancel:")
      ) {
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
        const pend = db
          .prepare(`SELECT * FROM drivers WHERE is_approved=0 AND full_name IS NOT NULL ORDER BY updated_at DESC LIMIT 30`)
          .all();

        if (!pend.length) {
          await tg("sendMessage", { chat_id: tgId, text: t(lang, "pendingNone") });
          return res.sendStatus(200);
        }

        for (const d of pend) {
          await tg("sendMessage", {
            chat_id: tgId,
            text: `⏳ Yeni sürücü\n👤 ${d.full_name}\n📞 ${d.phone}\n🚗 ${d.car}\n🔢 ${d.plate}\nID: ${d.tg_id}`,
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Təsdiq et", callback_data: `appr:${d.tg_id}` }],
                [{ text: "❌ Rədd et", callback_data: `rejdrv:${d.tg_id}` }],
              ],
            },
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
              `🎯 ${o.drop_text || (o.drop_lat && o.drop_lon ? `${o.drop_lat},${o.drop_lon}` : "-")}`,
          });
        }
        return res.sendStatus(200);
      }

      // Admin drivers list
      if (text === "/admin_drivers") {
        if (!isAdmin(tgId)) return res.sendStatus(200);

        const ds = db.prepare(
          `SELECT tg_id, full_name, phone, car, plate, is_online, last_lat, last_lon, updated_at
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
          out += `${d.is_online ? "🟢" : "⚪"} ${d.full_name || "-"} | ${d.phone || "-"}\n`;
          out += `ID:${d.tg_id} | ${d.car || "-"} | ${d.plate || "-"}\n\n`;
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
          db.prepare(`UPDATE drivers SET last_lat=?, last_lon=?, updated_at=? WHERE tg_id=?`)
            .run(lat, lon, now(), tgId);
        }

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

          const distanceKm = await getDistanceKm(pickupLat, pickupLon, lat, lon);
          const price = calcPrice(distanceKm);

          const info = db.prepare(
            `INSERT INTO orders(customer_id, status, pickup_lat, pickup_lon, drop_lat, drop_lon, drop_text, distance_km, price_azn, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`
          ).run(tgId, "searching", pickupLat, pickupLon, lat, lon, sess.tmp_drop_text ?? null, distanceKm, price, now(), now());

          const orderId = info.lastInsertRowid;
          clearSession(tgId);

          await tg("sendMessage", {
            chat_id: tgId,
            text: t(lang, "orderCreated", orderId, distanceKm, price),
            reply_markup: mainKb(lang),
          });

          // find drivers and offer
          const candidates = getCandidateDrivers(pickupLat, pickupLon, OFFER_DRIVERS);
          if (!candidates.length) {
            db.prepare(`UPDATE orders SET status='no_driver', updated_at=? WHERE id=?`).run(now(), orderId);
            await tg("sendMessage", { chat_id: tgId, text: t(lang, "noDriver") });
            return res.sendStatus(200);
          }

          const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);

          for (const c of candidates) {
            db.prepare(`INSERT INTO offers(order_id, driver_id, status, created_at, updated_at) VALUES(?,?,?,?,?)`)
              .run(orderId, c.tg_id, "offered", now(), now());
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

        await tg("sendMessage", {
          chat_id: tgId,
          text:
            "🚖 Sürücü paneli\n\n" +
            (d ? `Təsdiq: ${d.is_approved ? "✅" : "⏳"}\nOnline: ${isOnline ? "🟢" : "⚪"}` : "Sən hələ qeydiyyatdan keçməmisən."),
          reply_markup: driverKb(isOnline),
        });
        return res.sendStatus(200);
      }

      // driver registration
      if (text === "📝 Qeydiyyat") {
        db.prepare(
          `INSERT INTO drivers(tg_id, is_approved, is_online, updated_at)
           VALUES(?,?,?,?)
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
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Təsdiq et", callback_data: `appr:${d.tg_id}` }],
                [{ text: "❌ Rədd et", callback_data: `rejdrv:${d.tg_id}` }],
              ],
            },
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
