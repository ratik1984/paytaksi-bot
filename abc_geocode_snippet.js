// ====== A+B+C: Destination text -> Maps links + Geocoding (Nominatim) ======
// 1) Add these helpers near your existing map helpers:

function gmapsQuery(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function normQuery(q) {
  return (q || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// 2) Add this table once at startup (db.exec area):
// CREATE TABLE IF NOT EXISTS geocode_cache (
//   q TEXT PRIMARY KEY,
//   lat REAL,
//   lon REAL,
//   display_name TEXT,
//   updated_at INTEGER
// );

// 3) Add this function (after db + helpers). It uses OpenStreetMap Nominatim.
// NOTE: Has limits. For heavy traffic you should self-host.
async function geocodePlace(qRaw) {
  const q = normQuery(qRaw);
  if (!q || q.length < 3) return null;

  try {
    const cached = db.prepare(`SELECT lat, lon, display_name, updated_at FROM geocode_cache WHERE q=?`).get(q);
    if (cached && (now() - Number(cached.updated_at || 0) < 30 * 86400)) {
      return { lat: Number(cached.lat), lon: Number(cached.lon), display_name: cached.display_name || qRaw, cached: true };
    }
  } catch (_) {}

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=az&q=${encodeURIComponent(qRaw)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      headers: {
        "user-agent": "PayTaksiBot/1.0 (contact: admin)",
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
      db.prepare(`INSERT INTO geocode_cache(q, lat, lon, display_name, updated_at)
                  VALUES(?,?,?,?,?)
                  ON CONFLICT(q) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, display_name=excluded.display_name, updated_at=excluded.updated_at`)
        .run(q, lat, lon, dn, now());
    } catch (_) {}

    return { lat, lon, display_name: dn, cached: false };
  } catch (e) {
    return null;
  }
}

// 4) In your driver offer message building, if you already have:
//    dropWaze = wazeLinkByQuery(order.drop_text)
//    THEN ALSO add:
//    dropG = gmapsQuery(order.drop_text)

// 5) In your customer drop TEXT handler (when sess.step === "customer_wait_drop" and message is text),
//    instead of asking for location, do this:
//    - setSession drop_text
//    - geocodePlace(text)
//    - if found -> create order with drop_lat/drop_lon and calculate OSRM distance+price
//    - if not found -> ask user to send location
//
// Example skeleton:

/*
if (sess && sess.step === "customer_wait_drop" && typeof text === "string" && text.trim().length) {
  const q = text.trim();
  setSession(tgId, "customer_wait_drop", { tmp_drop_text: q });

  const g = await geocodePlace(q);
  if (!g) {
    await tg("sendMessage", { chat_id: tgId, text: "❌ Ünvanı tapa bilmədim. Lokasiya göndər.", reply_markup: locKb() });
    return res.sendStatus(200);
  }

  const pickupLat = sess.tmp_pickup_lat;
  const pickupLon = sess.tmp_pickup_lon;

  const route = await getRoute(pickupLat, pickupLon, g.lat, g.lon);
  const distanceKm = route.km;
  const price = calcPrice(distanceKm);

  const info = db.prepare(
    `INSERT INTO orders(customer_id, status, pickup_lat, pickup_lon, drop_lat, drop_lon, drop_text, distance_km, price_azn, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(tgId, "searching", pickupLat, pickupLon, g.lat, g.lon, q, distanceKm, price, now(), now());

  const orderId = info.lastInsertRowid;
  clearSession(tgId);

  const dropW = wazeLinkByQuery(q);
  const dropG = gmapsQuery(q);

  await tg("sendMessage", { chat_id: tgId, text: `✅ Sifariş #${orderId}\n📏 ${distanceKm.toFixed(2)} km\n💰 ${price.toFixed(2)} AZN\n🧭 Waze: ${dropW}\n🗺️ Maps: ${dropG}` });
  // then continue with your existing dispatch to drivers...
}
*/
// ====== END ======
