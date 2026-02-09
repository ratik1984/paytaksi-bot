/**
 * PayTaksi Bot (Render Webhook)
 * - Customer order flow with destination search + OSRM distance/duration
 * - Driver panel: online/offline, accept/reject, statuses (Arrived/Started/Finished)
 * - Auto re-dispatch offer timeout
 * - Live tracking page (customer link) + JSON feed
 * - Orders history: /orders (customer), /myrides (driver)
 * - Ratings (customer -> driver), daily earnings (driver/admin)
 * - Admin panel: live orders + online drivers + logs
 *
 * ENV:
 *   BOT_TOKEN        (required)
 *   WEBHOOK_SECRET   (required)  e.g. paytaksi_bot
 *   ADMIN_IDS        optional, comma separated Telegram user IDs
 *   DATA_PATH        optional, default ./data.json
 *   OSRM_BASE        optional, default https://router.project-osrm.org
 *   PORT             optional (Render sets)
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, "data.json");
const OSRM_BASE = process.env.OSRM_BASE || "https://router.project-osrm.org";

if (!BOT_TOKEN) console.error("❌ Missing BOT_TOKEN env var");
if (!WEBHOOK_SECRET) console.error("❌ Missing WEBHOOK_SECRET env var");

const app = express();
app.use(express.json({ limit: "2mb" }));

/* -------------------- Storage -------------------- */
function nowTs() {
  return Date.now();
}
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const db = JSON.parse(raw);
    db.users ||= {};
    db.orders ||= {};
    db.logs ||= [];
    db.seq ||= 1;
    return db;
  } catch {
    return { users: {}, orders: {}, logs: [], seq: 1 };
  }
}

let DB = loadDB();
let dbDirty = false;

function saveDBSoon() {
  dbDirty = true;
}
setInterval(() => {
  if (!dbDirty) return;
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(DB, null, 2));
    dbDirty = false;
  } catch (e) {
    console.error("DB save error:", e?.message || e);
  }
}, 1500);

function logEvent(type, data) {
  DB.logs.push({
    ts: nowTs(),
    type,
    data,
  });
  if (DB.logs.length > 2000) DB.logs.splice(0, DB.logs.length - 2000);
  saveDBSoon();
}

/* -------------------- Telegram API -------------------- */
async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) {
    console.error("TG API error:", method, j);
  }
  return j;
}

function isAdmin(tgId) {
  return ADMIN_IDS.has(String(tgId));
}

function getUser(tgId) {
  const id = String(tgId);
  DB.users[id] ||= {
    tgId: id,
    role: "customer", // customer|driver
    lang: "az",
    state: null,
    tmp: {},
    driver: {
      approved: false,
      online: false,
      lat: null,
      lon: null,
      navi: "waze", // waze|google
      ratingSum: 0,
      ratingCount: 0,
      earnings: {}, // yyyy-mm-dd => amount
    },
  };
  return DB.users[id];
}

function setState(u, state, tmp = {}) {
  u.state = state;
  u.tmp = { ...(u.tmp || {}), ...tmp };
  saveDBSoon();
}

function clearState(u) {
  u.state = null;
  u.tmp = {};
  saveDBSoon();
}

/* -------------------- Texts -------------------- */
const T = {
  az: {
    welcome: "Xoş gəldin!\n\nAşağıdan seçim et:",
    callTaxi: "🚕 Taksi çağır",
    driverPanel: "🚖 Sürücü paneli",
    sendPickup: "📍 Zəhmət olmasa götürülmə lokasiyanı göndər.",
    sendPickupBtn: "📍 Lokasiya göndər",
    askDestText: "🎯 Haraya gedirsən? Ünvanı yaz (mətn).",
    searchingDest: "🔎 Ünvan axtarılır...",
    chooseDest: "📌 Tapılan ünvanlar (seç):",
    confirmOrder: "✅ Sifarişi təsdiqlə",
    cancel: "❌ Ləğv et",
    orderSummary: (km, min, price) =>
      `🧾 Sifariş məlumatı:\n\n📏 Məsafə: ${km.toFixed(2)} km\n⏱️ Vaxt: ${Math.ceil(
        min
      )} dəq\n💰 Qiymət: ${price.toFixed(2)} AZN\n\nÖdəniş: nağd`,
    noDrivers: "😕 Hazırda onlayn sürücü tapılmadı. Bir az sonra yenə yoxla.",
    orderCreated: "✅ Sifariş yaradıldı. Sürücü axtarılır...",
    driverOfferTitle: "🚕 Yeni sifariş təklifi",
    accept: "✅ Qəbul et",
    reject: "❌ Rədd et",
    arrived: "📍 Gəldim",
    started: "▶️ Started",
    finished: "✅ Finished",
    navOpenWaze: "🧭 Waze ilə aç",
    navOpenGoogle: "🧭 Google ilə aç",
    driverOnline: "🟢 Online",
    driverOffline: "⚪ Offline",
    naviChoice: "🧭 Navi seçimi",
    chooseNavi: "Default navi seç:",
    naviSet: (v) => `✅ Navi seçimi: ${v === "waze" ? "Waze" : "Google Maps"}`,
    sendDriverLoc: "📍 İndi lokasiyanı göndər (sürücü).",
    needApproval:
      "⛔ Sürücü qeydiyyatın təsdiq gözləyir. Admin təsdiq edəndən sonra online ola biləcəksən.",
    driverRegistered:
      "📝 Sürücü qeydiyyatı tamamlandı. Admin təsdiqi gözlənilir.",
    adminNewDriver: (id) =>
      `👮 Yeni sürücü qeydiyyatı:\nTG ID: ${id}\nTəsdiqlə?`,
    adminApprove: "✅ Təsdiqlə",
    adminReject: "❌ Rədd",
    customerDriverAccepted: (nameOrId) =>
      `✅ Sürücü qəbul etdi: ${nameOrId}\n\n📍 Sürücü yaxınlaşır...`,
    customerDriverArrived: "📍 Sürücü gəldi. Çölə çıx 🙂",
    customerRideStarted: "🚕 Yol başladı.",
    customerRideFinished: (price) =>
      `✅ Sifariş bitdi.\n💰 Ödəniləcək: ${price.toFixed(2)} AZN (nağd)\n\n⭐ Sürücünü qiymətləndir:`,
    rate1: "⭐ 1",
    rate2: "⭐ 2",
    rate3: "⭐ 3",
    rate4: "⭐ 4",
    rate5: "⭐ 5",
    ratedThanks: "🙏 Təşəkkürlər! Rəyiniz qeydə alındı.",
    ordersTitle: "📜 Sifariş tarixçən:",
    ridesTitle: "📜 Sürüş tarixçən:",
    none: "— yoxdur —",
    adminPanel: "👮 Admin panel",
    adminLiveOrders: "📋 Canlı sifarişlər",
    adminDriversOnline: "🟢 Online sürücülər",
    adminLogs: "🧾 Log",
    callCustomer: "📞 Müştəriyə zəng et",
    progressFmt: (km, min) => `📍 Sürücü yaxınlaşır: təxmini qalıb ${km.toFixed(1)} km / ${Math.ceil(min)} dəq`,
  },
};

function t(lang, key, ...args) {
  const l = T[lang] ? lang : "az";
  const v = T[l][key];
  return typeof v === "function" ? v(...args) : v;
}

/* -------------------- Helpers -------------------- */
function mainKb(lang) {
  return {
    keyboard: [[{ text: t(lang, "callTaxi") }], [{ text: t(lang, "driverPanel") }]],
    resize_keyboard: true,
  };
}

function pickupKb(lang) {
  return {
    keyboard: [[{ text: t(lang, "sendPickupBtn"), request_location: true }], [{ text: t(lang, "cancel") }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function driverKb(lang, u) {
  const onlineText = u.driver.online ? t(lang, "driverOffline") : t(lang, "driverOnline");
  return {
    keyboard: [
      [{ text: onlineText }, { text: t(lang, "naviChoice") }],
      [{ text: "📝 Qeydiyyat" }],
      [{ text: "/myrides" }],
      [{ text: t(lang, "cancel") }],
    ],
    resize_keyboard: true,
  };
}

function inlineBtns(buttons) {
  return { inline_keyboard: buttons };
}

function priceRule(distKm) {
  // Start: 3.50 AZN up to 3 km. After 3 km: +0.40 per 1 km (exact).
  const base = 3.5;
  const extra = Math.max(0, distKm - 3);
  const price = base + extra * 0.4;
  return Math.round(price * 100) / 100;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
}

async function osrmRoute(from, to) {
  const url = `${OSRM_BASE}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&annotations=false`;
  const res = await fetch(url);
  const j = await res.json();
  if (!j || j.code !== "Ok" || !j.routes || !j.routes[0]) return null;
  return {
    distance_m: j.routes[0].distance,
    duration_s: j.routes[0].duration,
  };
}

async function nominatimSearch(q) {
  // light, best-effort geocode. Respect rate limits; keep minimal.
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q,
      format: "json",
      limit: "3",
      countrycodes: "az",
    }).toString();

  const res = await fetch(url, {
    headers: { "user-agent": "PayTaksiBot/1.0 (contact: none)" },
  });
  const j = await res.json().catch(() => []);
  if (!Array.isArray(j)) return [];
  return j
    .filter((x) => x && x.lat && x.lon)
    .map((x) => ({
      name: x.display_name,
      lat: Number(x.lat),
      lon: Number(x.lon),
    }));
}

function orderId() {
  const id = DB.seq++;
  saveDBSoon();
  return String(id);
}

function prettyUserName(from) {
  const parts = [from.first_name, from.last_name].filter(Boolean);
  const n = parts.join(" ").trim();
  return n || (from.username ? `@${from.username}` : String(from.id));
}

function safeText(s) {
  return (s || "").toString().trim();
}

/* -------------------- Order + Dispatch -------------------- */
function listOnlineApprovedDrivers() {
  return Object.values(DB.users).filter(
    (u) => u.role === "driver" && u.driver.approved && u.driver.online && u.driver.lat && u.driver.lon
  );
}

function pickBestDriver(order) {
  const drivers = listOnlineApprovedDrivers();
  if (!drivers.length) return null;

  // AI dispatch (simple): nearest to pickup
  let best = null;
  let bestD = Infinity;
  for (const d of drivers) {
    const km = haversineKm(d.driver.lat, d.driver.lon, order.pickup.lat, order.pickup.lon);
    if (km < bestD) {
      bestD = km;
      best = d;
    }
  }
  return best;
}

async function sendDriverOffer(order, driver) {
  const lang = driver.lang || "az";
  const msg =
    `🔔🔔 ${t(lang, "driverOfferTitle")}\n\n` +
    `📍 Pickup: ${order.pickup.lat.toFixed(5)}, ${order.pickup.lon.toFixed(5)}\n` +
    `🎯 Dest: ${order.dropoff.text}\n` +
    `📏 ${order.distanceKm.toFixed(2)} km • ⏱️ ${Math.ceil(order.durationMin)} dəq • 💰 ${order.price.toFixed(2)} AZN`;

  const r = await tg("sendMessage", {
    chat_id: driver.tgId,
    text: msg,
    reply_markup: inlineBtns([
      [
        { text: t(lang, "accept"), callback_data: `acc:${order.id}` },
        { text: t(lang, "reject"), callback_data: `rej:${order.id}` },
      ],
    ]),
  });

  if (r.ok && r.result?.message_id) {
    order.offer = order.offer || {};
    order.offer.lastOfferMsgId = r.result.message_id;
    saveDBSoon();
  }
}

function scheduleOfferTimeout(orderId, ms) {
  setTimeout(async () => {
    const o = DB.orders[orderId];
    if (!o) return;
    if (o.status !== "OFFERED") return;
    // timeout -> redispatch
    logEvent("offer_timeout", { orderId });
    await redispatchOrder(o, "timeout");
  }, ms);
}

async function redispatchOrder(order, reason) {
  // mark previous driver (if offered) as skipped
  order.offer ||= {};
  order.offer.skipped ||= [];
  if (order.offer.currentDriverId) order.offer.skipped.push(order.offer.currentDriverId);
  order.offer.currentDriverId = null;

  const drivers = listOnlineApprovedDrivers().filter((d) => !order.offer.skipped.includes(d.tgId));
  if (!drivers.length) {
    order.status = "SEARCHING";
    saveDBSoon();
    await tg("sendMessage", { chat_id: order.customerId, text: t(getUser(order.customerId).lang, "noDrivers") });
    return;
  }

  // pick nearest among remaining
  let best = null;
  let bestKm = Infinity;
  for (const d of drivers) {
    const km = haversineKm(d.driver.lat, d.driver.lon, order.pickup.lat, order.pickup.lon);
    if (km < bestKm) {
      bestKm = km;
      best = d;
    }
  }

  order.status = "OFFERED";
  order.offer.currentDriverId = best.tgId;
  order.offer.expiresAt = nowTs() + 25000;
  saveDBSoon();

  await sendDriverOffer(order, best);
  // notify customer progress (optional)
  await sendOrUpdateCustomerProgress(order);
  scheduleOfferTimeout(order.id, 25000);
}

async function sendOrUpdateCustomerProgress(order) {
  const c = getUser(order.customerId);
  const lang = c.lang || "az";

  // Need driver's current position to compute ETA to pickup
  let distKm = null;
  let etaMin = null;

  if (order.driverId) {
    const d = getUser(order.driverId);
    if (d.driver.lat && d.driver.lon) {
      const r = await osrmRoute(
        { lat: d.driver.lat, lon: d.driver.lon },
        { lat: order.pickup.lat, lon: order.pickup.lon }
      );
      if (r) {
        distKm = r.distance_m / 1000;
        etaMin = r.duration_s / 60;
        order.etaToPickupMin = etaMin;
        order.etaToPickupKm = distKm;
        saveDBSoon();
      }
    }
  }

  const text =
    distKm != null && etaMin != null ? t(lang, "progressFmt", distKm, etaMin) : "📍 Sürücü yaxınlaşır...";
  if (order.customerProgressMsgId) {
    await tg("editMessageText", {
      chat_id: order.customerId,
      message_id: order.customerProgressMsgId,
      text,
      reply_markup: inlineBtns([[{ text: "🗺️ Sürücü canlı xəritə", url: `${PUBLIC_URL()}/track/${order.id}` }]]),
    });
  } else {
    const r = await tg("sendMessage", {
      chat_id: order.customerId,
      text,
      reply_markup: inlineBtns([[{ text: "🗺️ Sürücü canlı xəritə", url: `${PUBLIC_URL()}/track/${order.id}` }]]),
    });
    if (r.ok && r.result?.message_id) {
      order.customerProgressMsgId = r.result.message_id;
      saveDBSoon();
    }
  }
}

function PUBLIC_URL() {
  // Render provides RENDER_EXTERNAL_URL sometimes; else use primary URL env or fallback placeholder.
  return process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "https://paytaksi-bot.onrender.com";
}

/* -------------------- Auto ETA refresh (every 2 min) -------------------- */
setInterval(async () => {
  try {
    const active = Object.values(DB.orders).filter((o) =>
      ["ACCEPTED", "ARRIVED", "IN_RIDE", "OFFERED"].includes(o.status)
    );
    for (const o of active) {
      if (!o.driverId) continue;
      const d = getUser(o.driverId);
      if (!d.driver.lat || !d.driver.lon) continue;

      if (o.status === "ACCEPTED" || o.status === "OFFERED") {
        await sendOrUpdateCustomerProgress(o);
      }
    }
  } catch (e) {
    console.error("ETA refresh error:", e?.message || e);
  }
}, 120000);

/* -------------------- Web endpoints -------------------- */
app.get("/", (req, res) => res.status(200).send("PayTaksi bot OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Live tracking HTML
app.get("/track/:orderId", (req, res) => {
  const o = DB.orders[String(req.params.orderId)];
  if (!o) return res.status(404).send("Order not found");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>PayTaksi Live</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <style>html,body,#map{height:100%;margin:0}</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const orderId = ${JSON.stringify(String(req.params.orderId))};
  const map = L.map('map').setView([${o.pickup.lat}, ${o.pickup.lon}], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
  const pickup = L.marker([${o.pickup.lat}, ${o.pickup.lon}]).addTo(map).bindPopup('Pickup').openPopup();
  const dest = L.marker([${o.dropoff.lat}, ${o.dropoff.lon}]).addTo(map).bindPopup('Destination');
  let drv = null;
  async function tick(){
    const r = await fetch('/track/' + orderId + '.json', {cache:'no-store'});
    const j = await r.json().catch(()=>null);
    if(!j || !j.driver) return;
    const p = [j.driver.lat, j.driver.lon];
    if(!drv){ drv = L.marker(p).addTo(map).bindPopup('Driver'); }
    drv.setLatLng(p);
  }
  tick();
  setInterval(tick, 5000);
</script>
</body>
</html>`);
});

// Live tracking JSON
app.get("/track/:orderId.json", (req, res) => {
  const o = DB.orders[String(req.params.orderId)];
  if (!o || !o.driverId) return res.status(404).json({ ok: false });
  const d = getUser(o.driverId);
  if (!d.driver.lat || !d.driver.lon) return res.status(404).json({ ok: false });
  res.json({
    ok: true,
    orderId: o.id,
    status: o.status,
    driver: { lat: d.driver.lat, lon: d.driver.lon },
  });
});

/* -------------------- Webhook endpoint -------------------- */
app.post(`/tg/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const upd = req.body || {};
    // Always respond 200 quickly (avoid Telegram retries)
    res.sendStatus(200);

    if (upd.message) await onMessage(upd.message);
    if (upd.callback_query) await onCallback(upd.callback_query);
  } catch (e) {
    console.error("Webhook error:", e?.message || e);
    // already 200
  }
});

/* -------------------- Bot logic -------------------- */
async function onMessage(msg) {
  const tgId = String(msg.chat.id);
  const u = getUser(tgId);
  const lang = u.lang || "az";
  const text = safeText(msg.text);

  // Track driver location updates if driver
  if (msg.location) {
    if (u.role === "driver") {
      u.driver.lat = msg.location.latitude;
      u.driver.lon = msg.location.longitude;
      saveDBSoon();

      // Update customer progress if driver has active order
      const active = Object.values(DB.orders).find((o) => o.driverId === tgId && ["ACCEPTED", "OFFERED"].includes(o.status));
      if (active) {
        await sendOrUpdateCustomerProgress(active);
      }
    }

    if (u.state === "await_pickup") {
      setState(u, "await_dest_text", {
        pickup: { lat: msg.location.latitude, lon: msg.location.longitude },
      });
      await tg("sendMessage", {
        chat_id: tgId,
        text: t(lang, "askDestText"),
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
  }

  // Commands
  if (text === "/start") {
    clearState(u);
    await tg("sendMessage", { chat_id: tgId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
    return;
  }

  if (text === "/id" || text === "/ID") {
    await tg("sendMessage", { chat_id: tgId, text: `Sənin Telegram ID: ${tgId}` });
    return;
  }

  if (text === "/orders") {
    const orders = Object.values(DB.orders)
      .filter((o) => o.customerId === tgId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);

    const lines = orders.length
      ? orders.map((o) => `#${o.id} • ${o.status} • ${o.price.toFixed(2)} AZN • ${new Date(o.createdAt).toLocaleString()}`).join("\n")
      : t(lang, "none");

    await tg("sendMessage", { chat_id: tgId, text: `${t(lang, "ordersTitle")}\n\n${lines}` });
    return;
  }

  if (text === "/myrides") {
    const rides = Object.values(DB.orders)
      .filter((o) => o.driverId === tgId && ["COMPLETED"].includes(o.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);

    const lines = rides.length
      ? rides.map((o) => `#${o.id} • ${o.price.toFixed(2)} AZN • ⭐ ${o.rating || "—"} • ${new Date(o.createdAt).toLocaleString()}`).join("\n")
      : t(lang, "none");

    await tg("sendMessage", { chat_id: tgId, text: `${t(lang, "ridesTitle")}\n\n${lines}` });
    return;
  }

  if (text === "/admin" && isAdmin(tgId)) {
    await sendAdminHome(tgId);
    return;
  }

  // Normalize for keyboard buttons (fix loop): use includes
  if (text && text.includes("Taksi çağır")) {
    clearState(u);
    setState(u, "await_pickup", {});
    await tg("sendMessage", {
      chat_id: tgId,
      text: t(lang, "sendPickup"),
      reply_markup: pickupKb(lang),
    });
    return;
  }

  if (text && text.includes("Sürücü paneli")) {
    u.role = "driver";
    saveDBSoon();
    await tg("sendMessage", { chat_id: tgId, text: `${t(lang, "driverPanel")}\n🧭 Navi: ${u.driver.navi === "waze" ? "Waze" : "Google Maps"}`, reply_markup: driverKb(lang, u) });
    return;
  }

  if (text === "📝 Qeydiyyat") {
    u.role = "driver";
    if (u.driver.approved) {
      await tg("sendMessage", { chat_id: tgId, text: "✅ Sən artıq təsdiqlənmisən." });
      return;
    }
    // manual registration: notify admins
    u.driver.approved = false;
    saveDBSoon();
    await tg("sendMessage", { chat_id: tgId, text: t(lang, "driverRegistered") });

    for (const adminId of ADMIN_IDS) {
      await tg("sendMessage", {
        chat_id: adminId,
        text: t("az", "adminNewDriver", tgId),
        reply_markup: inlineBtns([
          [
            { text: t("az", "adminApprove"), callback_data: `adm_ok:${tgId}` },
            { text: t("az", "adminReject"), callback_data: `adm_no:${tgId}` },
          ],
        ]),
      });
    }
    logEvent("driver_register", { tgId });
    return;
  }

  if (text === t(lang, "driverOnline") || text === "🟢 Online") {
    if (!u.driver.approved) {
      await tg("sendMessage", { chat_id: tgId, text: t(lang, "needApproval") });
      return;
    }
    u.driver.online = true;
    saveDBSoon();
    await tg("sendMessage", { chat_id: tgId, text: t(lang, "sendDriverLoc") });
    return;
  }

  if (text === t(lang, "driverOffline") || text === "⚪ Offline") {
    u.driver.online = false;
    saveDBSoon();
    await tg("sendMessage", { chat_id: tgId, text: "⚪ Offline oldu." });
    return;
  }

  if (text === t(lang, "naviChoice") || text === "🧭 Navi seçimi") {
    await tg("sendMessage", {
      chat_id: tgId,
      text: t(lang, "chooseNavi"),
      reply_markup: { keyboard: [[{ text: "✅ Waze" }], [{ text: "Google Maps" }], [{ text: t(lang, "cancel") }]], resize_keyboard: true },
    });
    return;
  }

  if (text === "✅ Waze") {
    u.driver.navi = "waze";
    saveDBSoon();
    await tg("sendMessage", { chat_id: tgId, text: t(lang, "naviSet", "waze"), reply_markup: driverKb(lang, u) });
    return;
  }
  if (text === "Google Maps") {
    u.driver.navi = "google";
    saveDBSoon();
    await tg("sendMessage", { chat_id: tgId, text: t(lang, "naviSet", "google"), reply_markup: driverKb(lang, u) });
    return;
  }

  if (text === t(lang, "cancel") || text === "❌ Ləğv et") {
    clearState(u);
    await tg("sendMessage", { chat_id: tgId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
    return;
  }

  // State machine: destination search
  if (u.state === "await_dest_text") {
    const q = text;
    if (!q) return;

    await tg("sendMessage", { chat_id: tgId, text: t(lang, "searchingDest") });

    const results = await nominatimSearch(q);
    if (!results.length) {
      await tg("sendMessage", { chat_id: tgId, text: "😕 Ünvan tapılmadı. Yenidən yaz." });
      return;
    }

    u.tmp.destCandidates = results;
    setState(u, "await_dest_pick", {});

    const buttons = results.map((r, i) => [{ text: `📍 ${r.name.slice(0, 42)}`, callback_data: `dest:${i}` }]);
    buttons.push([{ text: t(lang, "cancel"), callback_data: "dest_cancel" }]);

    await tg("sendMessage", {
      chat_id: tgId,
      text: t(lang, "chooseDest"),
      reply_markup: inlineBtns(buttons),
    });
    return;
  }

  // Unknown text: DO NOT spam welcome (prevents loop)
  return;
}

async function onCallback(q) {
  const tgId = String(q.from.id);
  const u = getUser(tgId);
  const lang = u.lang || "az";
  const data = safeText(q.data);

  // always answer callback
  await tg("answerCallbackQuery", { callback_query_id: q.id });

  // Admin approvals
  if (data.startsWith("adm_ok:") && isAdmin(tgId)) {
    const did = data.split(":")[1];
    const du = getUser(did);
    du.role = "driver";
    du.driver.approved = true;
    saveDBSoon();
    await tg("sendMessage", { chat_id: did, text: "✅ Admin təsdiqlədi. İndi Online ola bilərsən." });
    logEvent("admin_approve_driver", { admin: tgId, driver: did });
    return;
  }
  if (data.startsWith("adm_no:") && isAdmin(tgId)) {
    const did = data.split(":")[1];
    const du = getUser(did);
    du.driver.approved = false;
    du.driver.online = false;
    saveDBSoon();
    await tg("sendMessage", { chat_id: did, text: "⛔ Admin qeydiyyatı rədd etdi." });
    logEvent("admin_reject_driver", { admin: tgId, driver: did });
    return;
  }

  // Destination chosen
  if (data === "dest_cancel") {
    clearState(u);
    await tg("sendMessage", { chat_id: tgId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
    return;
  }

  if (data.startsWith("dest:")) {
    const idx = Number(data.split(":")[1]);
    const list = u.tmp.destCandidates || [];
    const chosen = list[idx];
    if (!chosen || !u.tmp.pickup) return;

    // compute OSRM from pickup to chosen
    const pickup = u.tmp.pickup;
    const drop = { lat: chosen.lat, lon: chosen.lon, text: chosen.name };

    const r = await osrmRoute(pickup, drop);
    if (!r) {
      await tg("sendMessage", { chat_id: tgId, text: "❌ OSRM hesablamadı. Yenidən cəhd et." });
      return;
    }

    const distKm = r.distance_m / 1000;
    const durMin = r.duration_s / 60;
    const price = priceRule(distKm);

    setState(u, "await_order_confirm", {
      pickup,
      drop,
      distKm,
      durMin,
      price,
    });

    await tg("sendMessage", {
      chat_id: tgId,
      text: t(lang, "orderSummary", distKm, durMin, price),
      reply_markup: inlineBtns([
        [{ text: t(lang, "confirmOrder"), callback_data: "ord_ok" }],
        [{ text: t(lang, "cancel"), callback_data: "ord_cancel" }],
      ]),
    });

    // show destination pin
    await tg("sendLocation", { chat_id: tgId, latitude: drop.lat, longitude: drop.lon });
    return;
  }

  // Order confirm/cancel
  if (data === "ord_cancel") {
    clearState(u);
    await tg("sendMessage", { chat_id: tgId, text: t(lang, "welcome"), reply_markup: mainKb(lang) });
    return;
  }

  if (data === "ord_ok") {
    const tmp = u.tmp || {};
    if (!tmp.pickup || !tmp.drop) return;

    const id = orderId();
    const order = {
      id,
      customerId: String(tgId),
      driverId: null,
      status: "SEARCHING",
      pickup: tmp.pickup,
      dropoff: { lat: tmp.drop.lat, lon: tmp.drop.lon, text: tmp.drop.text },
      distanceKm: Number(tmp.distKm),
      durationMin: Number(tmp.durMin),
      price: Number(tmp.price),
      createdAt: nowTs(),
      updatedAt: nowTs(),
      offer: { skipped: [] },
      rating: null,
    };
    DB.orders[id] = order;
    saveDBSoon();
    clearState(u);

    await tg("sendMessage", { chat_id: tgId, text: t(lang, "orderCreated"), reply_markup: mainKb(lang) });

    // dispatch
    const best = pickBestDriver(order);
    if (!best) {
      await tg("sendMessage", { chat_id: tgId, text: t(lang, "noDrivers") });
      return;
    }

    order.status = "OFFERED";
    order.offer.currentDriverId = best.tgId;
    order.offer.expiresAt = nowTs() + 25000;
    saveDBSoon();

    await sendDriverOffer(order, best);
    scheduleOfferTimeout(order.id, 25000);
    logEvent("order_created", { orderId: id, customerId: tgId });
    return;
  }

  // Driver accept/reject
  if (data.startsWith("acc:")) {
    const oid = data.split(":")[1];
    const o = DB.orders[oid];
    if (!o) return;

    // only current offered driver can accept
    if (o.status === "OFFERED" && o.offer?.currentDriverId && o.offer.currentDriverId !== tgId) return;

    o.driverId = tgId;
    o.status = "ACCEPTED";
    o.updatedAt = nowTs();
    saveDBSoon();

    const driver = getUser(tgId);
    const c = getUser(o.customerId);

    // notify customer
    await tg("sendMessage", {
      chat_id: o.customerId,
      text: t(c.lang, "customerDriverAccepted", driver.tgId),
      reply_markup: inlineBtns([[{ text: "🗺️ Sürücü canlı xəritə", url: `${PUBLIC_URL()}/track/${o.id}` }]]),
    });

    // send driver controls: status + nav + call
    const navUrl = makeNavUrl(driver.driver.navi, o.pickup.lat, o.pickup.lon, o.dropoff.lat, o.dropoff.lon);
    await tg("sendMessage", {
      chat_id: tgId,
      text: `✅ Sifariş qəbul edildi (#${o.id}).\n\n📍 Pickup-a get.`,
      reply_markup: inlineBtns([
        [
          { text: t(lang, "arrived"), callback_data: `st_arr:${o.id}` },
          { text: t(lang, "started"), callback_data: `st_sta:${o.id}` },
          { text: t(lang, "finished"), callback_data: `st_fin:${o.id}` },
        ],
        [
          { text: driver.driver.navi === "waze" ? t(lang, "navOpenWaze") : t(lang, "navOpenGoogle"), url: navUrl },
        ],
      ]),
    });

    // customer progress (ETA)
    await sendOrUpdateCustomerProgress(o);

    logEvent("order_accepted", { orderId: oid, driverId: tgId });
    return;
  }

  if (data.startsWith("rej:")) {
    const oid = data.split(":")[1];
    const o = DB.orders[oid];
    if (!o) return;
    if (o.status !== "OFFERED") return;

    // only current offered driver can reject
    if (o.offer?.currentDriverId && o.offer.currentDriverId !== tgId) return;

    logEvent("order_rejected", { orderId: oid, driverId: tgId });
    await redispatchOrder(o, "reject");
    return;
  }

  // Driver status updates
  if (data.startsWith("st_arr:")) {
    const oid = data.split(":")[1];
    const o = DB.orders[oid];
    if (!o || o.driverId !== tgId) return;
    o.status = "ARRIVED";
    o.updatedAt = nowTs();
    saveDBSoon();
    await tg("sendMessage", { chat_id: o.customerId, text: t(getUser(o.customerId).lang, "customerDriverArrived") });
    logEvent("status_arrived", { orderId: oid });
    return;
  }

  if (data.startsWith("st_sta:")) {
    const oid = data.split(":")[1];
    const o = DB.orders[oid];
    if (!o || o.driverId !== tgId) return;
    o.status = "IN_RIDE";
    o.updatedAt = nowTs();
    saveDBSoon();
    await tg("sendMessage", { chat_id: o.customerId, text: t(getUser(o.customerId).lang, "customerRideStarted") });
    logEvent("status_started", { orderId: oid });
    return;
  }

  if (data.startsWith("st_fin:")) {
    const oid = data.split(":")[1];
    const o = DB.orders[oid];
    if (!o || o.driverId !== tgId) return;
    o.status = "COMPLETED";
    o.updatedAt = nowTs();
    saveDBSoon();

    // add earnings
    const d = getUser(tgId);
    const key = todayKey();
    d.driver.earnings[key] = (d.driver.earnings[key] || 0) + o.price;
    saveDBSoon();

    // ask customer rating
    const c = getUser(o.customerId);
    await tg("sendMessage", {
      chat_id: o.customerId,
      text: t(c.lang, "customerRideFinished", o.price),
      reply_markup: inlineBtns([
        [
          { text: t(c.lang, "rate1"), callback_data: `rate:${o.id}:1` },
          { text: t(c.lang, "rate2"), callback_data: `rate:${o.id}:2` },
          { text: t(c.lang, "rate3"), callback_data: `rate:${o.id}:3` },
          { text: t(c.lang, "rate4"), callback_data: `rate:${o.id}:4` },
          { text: t(c.lang, "rate5"), callback_data: `rate:${o.id}:5` },
        ],
      ]),
    });

    logEvent("status_finished", { orderId: oid, price: o.price });
    return;
  }

  // Rating
  if (data.startsWith("rate:")) {
    const [, oid, scoreStr] = data.split(":");
    const score = Number(scoreStr);
    const o = DB.orders[oid];
    if (!o || o.customerId !== tgId) return;
    if (o.rating) return;

    o.rating = score;
    saveDBSoon();

    // update driver rating
    if (o.driverId) {
      const d = getUser(o.driverId);
      d.driver.ratingSum += score;
      d.driver.ratingCount += 1;
      saveDBSoon();
    }

    await tg("sendMessage", { chat_id: tgId, text: t(lang, "ratedThanks"), reply_markup: mainKb(lang) });
    return;
  }

  // Admin panel callbacks could be added later
}

function makeNavUrl(navi, pLat, pLon, dLat, dLon) {
  // Provide a route link
  if (navi === "google") {
    return `https://www.google.com/maps/dir/?api=1&origin=${pLat},${pLon}&destination=${dLat},${dLon}&travelmode=driving`;
  }
  // Waze uses "ll" for destination, optionally "navigate=yes"
  return `https://waze.com/ul?ll=${dLat}%2C${dLon}&navigate=yes`;
}

/* -------------------- Admin messages -------------------- */
async function sendAdminHome(adminId) {
  const orders = Object.values(DB.orders).filter((o) => ["SEARCHING", "OFFERED", "ACCEPTED", "ARRIVED", "IN_RIDE"].includes(o.status));
  const driversOnline = listOnlineApprovedDrivers();

  const linesO = orders.length
    ? orders
        .slice(0, 20)
        .map((o) => `#${o.id} • ${o.status} • C:${o.customerId} • D:${o.driverId || "—"} • ${o.price.toFixed(2)} AZN`)
        .join("\n")
    : "—";

  const linesD = driversOnline.length ? driversOnline.map((d) => `🚖 ${d.tgId} • ${d.driver.navi} • ${d.driver.lat?.toFixed?.(4)},${d.driver.lon?.toFixed?.(4)}`).join("\n") : "—";

  await tg("sendMessage", {
    chat_id: adminId,
    text: `👮 Admin panel\n\n📋 Canlı sifarişlər:\n${linesO}\n\n🟢 Online sürücülər:\n${linesD}\n\n🧾 Log (son 10):\n${DB.logs.slice(-10).map((x) => `${new Date(x.ts).toLocaleString()} • ${x.type}`).join("\n")}`,
  });
}

/* -------------------- Start server -------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
