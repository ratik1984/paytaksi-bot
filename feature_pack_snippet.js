// ===== PayTaksi Feature Pack: Call button + Driver alert + Offer timeout/re-dispatch + Progress =====
//
// Bu fayl merge üçün hazırlanıb. Hazır işlək index.js-ə əlavələr kimi tətbiq et.
//
// (1) "Müştəriyə zəng et" düyməsi (driver accept edəndən sonra driver-ə göstər)
// (2) Offer gələndə sürücüyə bildiriş (səsli notif üçün disable_notification:false) + qısa emoji
// (3) Offer timeout (30s) + auto re-dispatch (növbəti sürücülərə göndər)
// (4) Müştəriyə progress: "təxmini qalıb: 1.2 km / 4 dəq" (pickup/drop)
//
// ---------------------------
// 0) DB əlavələri (əgər yoxdursa)
// ---------------------------
// orders cədvəlinə:
//   - customer_phone TEXT  (müştəri telefon verərsə)
// offers cədvəlinə:
//   - expires_at INTEGER   (offer timeout üçün)
// drivers cədvəlində (əgər yoxdursa):
//   - last_lat,last_lon  (artıq varsa ok)
//
// Safe alter nümunələri:
// safeAlter(`ALTER TABLE orders ADD COLUMN customer_phone TEXT`);
// safeAlter(`ALTER TABLE offers ADD COLUMN expires_at INTEGER`);
//
// ---------------------------
// 1) Müştəridən telefon alma (istəyə bağlı)
// ---------------------------
// Customer sifariş yaradanda (pickup alındıqdan sonra) bu addımı qoya bilərsən:
//
// reply_markup: {
//   keyboard: [
//     [{ text: "📞 Telefon paylaş", request_contact: true }],
//     [{ text: "⏭ Keç" }]
//   ],
//   resize_keyboard: true
// }
//
// contact gələndə:
// if (m.contact && sess.step === "customer_wait_phone") {
//   const phone = m.contact.phone_number; // e.g. 99450...
//   setSession(tgId, "customer_wait_drop", { tmp_customer_phone: phone });
// }
//
// Sonra order insert edəndə: customer_phone olaraq saxla.
//
// ---------------------------
// 2) "Zəng et" düyməsi (Driver-ə)
// ---------------------------
// Driver accept edəndən sonra order.customer_phone varsa driver-ə əlavə mesaj:
//
// const tel = normalizeTel(order.customer_phone);
// await tg("sendMessage", {
//   chat_id: driverId,
//   text: "📞 Müştəriyə zəng et:",
//   reply_markup: { inline_keyboard: [[{ text: "📞 Zəng et", url: `tel:${tel}` }]] }
// });
//
// Normalizasiya helper:
function normalizeTel(p) {
  if (!p) return null;
  let s = String(p).trim();
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) {
    // AZ default: 994...
    if (s.startsWith("994")) s = "+" + s;
    else if (s.startsWith("0")) s = "+994" + s.slice(1);
    else s = "+994" + s; // son çarə
  }
  return s;
}
//
// ---------------------------
// 3) Driver offer alert (səsli)
// ---------------------------
// Telegram bot "səs"i notif kimi verir. Bunun üçün disable_notification:false göndər.
// Offer göndərdiyin sendMessage-də bunu əlavə et:
//
// await tg("sendMessage", {
//   chat_id: driverId,
//   text: "🔔 Yeni sifariş gəldi!\n...",
//   disable_notification: false,
//   ...
// });
//
// (spam olmamaq üçün) eyni driver-ə eyni order üçün bir dəfə göndər.
//
// ---------------------------
// 4) Offer timeout + auto re-dispatch
// ---------------------------
// Constants:
const OFFER_TIMEOUT_SEC = 30;   // 20-30 sec arası
const REDISPATCH_BATCH = 5;     // hər round neçə driver

// Offer insert edəndə expires_at hesabla:
function offerExpiresAt() {
  return now() + OFFER_TIMEOUT_SEC;
}

// Offer insert:
/// db.prepare(`INSERT INTO offers(order_id, driver_id, status, created_at, updated_at, expires_at) VALUES(?,?,?,?,?,?)`)
///   .run(orderId, driverId, "offered", now(), now(), offerExpiresAt());

// Background checker (setInterval) – 5 saniyədən bir işləsin
async function offerTimeoutWorker() {
  const ts = now();

  // 4.1) expired offers
  const exp = db.prepare(
    `SELECT id, order_id, driver_id FROM offers
     WHERE status='offered' AND expires_at IS NOT NULL AND expires_at <= ?`
  ).all(ts);

  for (const o of exp) {
    db.prepare(`UPDATE offers SET status='expired', updated_at=? WHERE id=?`).run(ts, o.id);

    // Driver-ə məlumat (optional)
    // await tg("sendMessage", { chat_id: o.driver_id, text: "⌛ Offer vaxtı bitdi." });

    // Order hələ searching-dirsə re-dispatch et
    const ord = db.prepare(`SELECT id, status, pickup_lat, pickup_lon FROM orders WHERE id=?`).get(o.order_id);
    if (ord && ord.status === "searching") {
      await redispatchOrder(ord.id, ord.pickup_lat, ord.pickup_lon);
    }
  }
}

// Redispatch: əvvəl göndərilməyən sürücüləri tap
async function redispatchOrder(orderId, pLat, pLon) {
  const ord = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
  if (!ord || ord.status !== "searching") return;

  // artıq offer göndərilənlər
  const sent = db.prepare(`SELECT driver_id FROM offers WHERE order_id=?`).all(orderId).map(x => x.driver_id);

  // candidates: online + approved + location var + NOT IN sent
  const drivers = db.prepare(
    `SELECT tg_id, last_lat, last_lon
     FROM drivers
     WHERE is_approved=1 AND is_online=1
       AND last_lat IS NOT NULL AND last_lon IS NOT NULL`
  ).all();

  // məsafəyə görə sırala
  const ranked = drivers
    .filter(d => !sent.includes(d.tg_id))
    .map(d => ({ tg_id: d.tg_id, dist: haversineKm(pLat, pLon, d.last_lat, d.last_lon) }))
    .sort((a,b) => a.dist - b.dist)
    .slice(0, REDISPATCH_BATCH);

  if (!ranked.length) {
    // heç kim qalmadı -> no_driver
    db.prepare(`UPDATE orders SET status='no_driver', updated_at=? WHERE id=?`).run(now(), orderId);
    await tg("sendMessage", { chat_id: ord.customer_id, text: "❌ Hal-hazırda online sürücü tapılmadı." });
    return;
  }

  // order datasını götür
  const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);

  for (const r of ranked) {
    db.prepare(`INSERT INTO offers(order_id, driver_id, status, created_at, updated_at, expires_at) VALUES(?,?,?,?,?,?)`)
      .run(orderId, r.tg_id, "offered", now(), now(), offerExpiresAt());

    // Offer mesajını səsli notiflə göndər
    await tg("sendMessage", {
      chat_id: r.tg_id,
      text: `🔔 Yeni sifariş (#${orderId})\n📏 ${Number(order.distance_km||0).toFixed(2)} km\n💰 ${Number(order.price_azn||0).toFixed(2)} AZN`,
      disable_notification: false,
    });

    // sonra sənin mövcud offer UI-ni (accept/reject + Waze/Maps düymələri) çağır
    // await sendDriverOffer(r.tg_id, order);
  }
}

// setInterval
// setInterval(() => offerTimeoutWorker().catch(()=>{}), 5000);

//
// ---------------------------
// 5) Müştəriyə “progress” mesajı
// ---------------------------
// Səndə ETA refresh var (2 dəq). Orda route nəticəsindən həm km, həm də dəqiqə göstər:
//
// const route = await getRoute(driverLat, driverLon, targetLat, targetLon);
// const kmLeft = route.km.toFixed(1);
// const minLeft = Math.max(1, Math.ceil(route.sec/60));
// await tg("sendMessage", {
//   chat_id: order.customer_id,
//   text: `📍 Sürücü yaxınlaşır\n⏱️ Təxmini qalıb: ${kmLeft} km / ${minLeft} dəq\n🗺️ Canlı xəritə: ${gmapsLL(driverLat, driverLon)}`
// });
//
// Eyni formatı driver accept olan anda da göndər (ilk progress).
//
// ---------------------------
// 6) Accept zamanı “Zəng et” düyməsini driver-ə əlavə et
// ---------------------------
// driver accept logic-də, driver-ə nav mesajlarından sonra:
//
// if (order.customer_phone) {
//   const tel = normalizeTel(order.customer_phone);
//   if (tel) {
//     await tg("sendMessage", {
//       chat_id: driverId,
//       text: "📞 Müştəriyə zəng et:",
//       reply_markup: { inline_keyboard: [[{ text: "📞 Zəng et", url: `tel:${tel}` }]] }
//     });
//   }
// }
//
// ===== END =====
