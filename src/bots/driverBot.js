const { Telegraf, Markup } = require("telegraf");
const { prisma } = require("../db");
const { driverMain } = require("./keyboards");
const st = require("./state");
const { distanceKm } = require("../utils/geo");
const { calcFare, calcCommission, round2 } = require("../utils/pricing");

function bigPriceText(amount){
  // Telegram has no font-size control; emulate by using bold + spacing + emoji.
  return `💵 *MÜŞTƏRİDƏN ALINACAQ MƏBLƏĞ:*\n\n*${amount} AZN*`;
}

async function getDriverBalance(userId){
  const agg = await prisma.balanceLedger.aggregate({ where:{ userId }, _sum:{ amountAzN:true }});
  return round2(agg._sum.amountAzN || 0);
}

async function upsertDriver(ctx){
  const tgId = String(ctx.from.id);
  let user = await prisma.user.findUnique({ where: { telegramId: tgId }, include:{ driverProfile:true } });
  if (!user){
    user = await prisma.user.create({
      data: {
        telegramId: tgId,
        role: "DRIVER",
        firstName: ctx.from.first_name || null,
        lastName: ctx.from.last_name || null,
      },
      include:{ driverProfile:true }
    });
    await prisma.driverProfile.create({ data:{ userId:user.id }});
    user = await prisma.user.findUnique({ where:{ telegramId: tgId }, include:{ driverProfile:true }});
  }
  return user;
}

function createDriverBot(token, broadcastOnlineDriversRegistry, adminNotifyFn){
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const user = await upsertDriver(ctx);
    const dp = await prisma.driverProfile.findUnique({ where:{ userId:user.id }});
    if (dp.status === "PENDING"){
      st.set(user.telegramId, { step:"DRIVER_REG_NAME", data:{} });
      await ctx.reply("Salam Sürücü! Qeydiyyat başlayır.

1) Adınızı yazın (məs: Kenan):");
    }else{
      await ctx.reply("Salam! Sürücü paneli açıldı.", driverMain());
    }
  });

  // Registration wizard
  bot.on("text", async (ctx) => {
    const tgId = String(ctx.from.id);
    const s = st.get(tgId);
    if (!s || !s.step.startsWith("DRIVER_REG_")) return;

    const user = await upsertDriver(ctx);
    const dp = await prisma.driverProfile.findUnique({ where:{ userId:user.id }});

    if (s.step === "DRIVER_REG_NAME"){
      s.data.firstName = ctx.message.text.trim();
      s.step = "DRIVER_REG_SURNAME";
      st.set(tgId, s);
      return ctx.reply("2) Soyadınızı yazın:");
    }
    if (s.step === "DRIVER_REG_SURNAME"){
      s.data.lastName = ctx.message.text.trim();
      s.step = "DRIVER_REG_PHONE";
      st.set(tgId, s);
      return ctx.reply("3) Telefon nömrəsi yazın. Format: +994XXXXXXXXX");
    }
    if (s.step === "DRIVER_REG_PHONE"){
      const phone = ctx.message.text.trim();
      if (!phone.startsWith("+994") || phone.length < 8) return ctx.reply("Telefon +994 ilə başlamalıdır. Yenidən yazın:");
      s.data.phone = phone;
      s.step = "DRIVER_REG_CAR";
      st.set(tgId, s);
      return ctx.reply("4) Avtomobil marka/model (məs: Toyota Aqua 2017):");
    }
    if (s.step === "DRIVER_REG_CAR"){
      s.data.carBrandModel = ctx.message.text.trim();
      s.step = "DRIVER_REG_PLATE";
      st.set(tgId, s);
      return ctx.reply("5) Avtomobil nömrəsi (məs: 77SG147):");
    }
    if (s.step === "DRIVER_REG_PLATE"){
      s.data.carPlate = ctx.message.text.trim();
      s.step = "DRIVER_REG_CAR_PHOTO";
      st.set(tgId, s);
      return ctx.reply("6) Avtomobil şəkli göndərin (foto kimi):");
    }
  });

  bot.on("photo", async (ctx) => {
    const tgId = String(ctx.from.id);
    const s = st.get(tgId);
    const user = await upsertDriver(ctx);

    // registration photo steps
    if (s && s.step === "DRIVER_REG_CAR_PHOTO"){
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      s.data.carPhotoFileId = fileId;
      s.step = "DRIVER_REG_ID_FRONT";
      st.set(tgId, s);
      return ctx.reply("7) Şəxsiyyət vəsiqəsi (ÖN) foto göndərin:");
    }
    if (s && s.step === "DRIVER_REG_ID_FRONT"){
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      s.data.idFront = fileId;
      s.step = "DRIVER_REG_ID_BACK";
      st.set(tgId, s);
      return ctx.reply("8) Şəxsiyyət vəsiqəsi (ARXA) foto göndərin:");
    }
    if (s && s.step === "DRIVER_REG_ID_BACK"){
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      s.data.idBack = fileId;
      s.step = "DRIVER_REG_LICENSE";
      st.set(tgId, s);
      return ctx.reply("9) Sürücülük vəsiqəsi foto göndərin:");
    }
    if (s && s.step === "DRIVER_REG_LICENSE"){
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      s.data.license = fileId;
      s.step = "DRIVER_REG_TECH_FRONT";
      st.set(tgId, s);
      return ctx.reply("10) Texniki pasport (ÖN) foto göndərin:");
    }
    if (s && s.step === "DRIVER_REG_TECH_FRONT"){
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      s.data.techFront = fileId;
      s.step = "DRIVER_REG_TECH_BACK";
      st.set(tgId, s);
      return ctx.reply("11) Texniki pasport (ARXA) foto göndərin:");
    }
    if (s && s.step === "DRIVER_REG_TECH_BACK"){
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      s.data.techBack = fileId;

      // save all
      await prisma.user.update({ where:{ id:user.id }, data:{
        firstName: s.data.firstName,
        lastName: s.data.lastName,
        phone: s.data.phone
      }});

      const dp = await prisma.driverProfile.update({
        where:{ userId:user.id },
        data:{
          carBrandModel: s.data.carBrandModel,
          carPlate: s.data.carPlate,
          carPhotoFileId: s.data.carPhotoFileId,
          status: "PENDING"
        }
      });

      const docs = [
        { docType:"ID_FRONT", fileId:s.data.idFront },
        { docType:"ID_BACK", fileId:s.data.idBack },
        { docType:"DRIVER_LICENSE", fileId:s.data.license },
        { docType:"TECH_FRONT", fileId:s.data.techFront },
        { docType:"TECH_BACK", fileId:s.data.techBack },
      ];
      for (const d of docs){
        await prisma.driverDocument.create({ data:{ driverId: dp.id, docType:d.docType, fileId:d.fileId }});
      }

      st.clear(tgId);
      await ctx.reply("✅ Qeydiyyat tamamlandı. Admin təsdiqi gözlənilir.
Təsdiqdən sonra sifariş qəbul edə biləcəksiniz.", driverMain());

      await adminNotifyFn(`🧑‍✈️ Yeni sürücü qeydiyyatı: ${user.firstName||""} ${user.lastName||""}
TG: ${user.telegramId}
Nömrə: ${dp.carPlate||"-"}
Model: ${dp.carBrandModel||"-"}`);
      return;
    }

    // top up receipt
    const s2 = st.get(tgId);
    if (s2 && s2.step === "TOPUP_RECEIPT"){
      const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
      const amount = s2.data.amountAzN;
      await prisma.topUpRequest.create({ data:{ userId:user.id, amountAzN: amount, receiptFileId:fileId, status:"PENDING" }});
      st.clear(tgId);
      await ctx.reply("✅ Qəbz yükləndi. Admin təsdiqləyəndən sonra balansınıza əlavə olunacaq.", driverMain());
      await adminNotifyFn(`➕ Balans artırma sorğusu
Sürücü TG: ${user.telegramId}
Məbləğ: ${amount} AZN
(Admin paneldən təsdiqlə)`);
      return;
    }
  });

  bot.hears("🟢 Onlayn ol / Offlayn ol", async (ctx) => {
    const user = await upsertDriver(ctx);
    const dp = await prisma.driverProfile.findUnique({ where:{ userId:user.id }});
    if (dp.status !== "APPROVED"){
      return ctx.reply("⛔ Siz hələ təsdiqlənməmisiniz. Admin təsdiqindən sonra onlayn ola bilərsiniz.", driverMain());
    }
    const cur = broadcastOnlineDriversRegistry.isOnline(user.telegramId);
    if (cur){
      broadcastOnlineDriversRegistry.setOnline(user.telegramId, false);
      return ctx.reply("🔴 Offlayn oldunuz.", driverMain());
    }else{
      const bal = await getDriverBalance(user.id);
      if (bal <= -15){
        return ctx.reply("⛔ Balansınız -15 AZN və ya daha aşağıdır.
Səbəb: komissiya borcu.
Balans artırmadan sifariş qəbul edilmir.", driverMain());
      }
      broadcastOnlineDriversRegistry.setOnline(user.telegramId, true);
      return ctx.reply("🟢 Onlayn oldunuz. Yeni sifarişlər gələcək.", driverMain());
    }
  });

  bot.hears("💰 Balansım", async (ctx) => {
    const user = await upsertDriver(ctx);
    const bal = await getDriverBalance(user.id);
    const status = bal <= -15 ? "⛔ Limit: Sifariş qəbul edilmir (-15 AZN)" : "✅ Aktiv";
    await ctx.reply(`💰 Balans: ${bal} AZN
Status: ${status}`, driverMain());
  });

  bot.hears("➕ Balans artır", async (ctx) => {
    const user = await upsertDriver(ctx);
    st.set(user.telegramId, { step:"TOPUP_AMOUNT", data:{} });
    await ctx.reply("Balans artırma:
1) Məbləği yazın (məs: 10):");
  });

  bot.on("text", async (ctx, next) => {
    const tgId = String(ctx.from.id);
    const s = st.get(tgId);
    if (!s || s.step !== "TOPUP_AMOUNT") return next();
    const val = Number(String(ctx.message.text).replace(",", "."));
    if (!isFinite(val) || val <= 0) return ctx.reply("Düzgün məbləğ yazın (məs: 10):");
    s.data.amountAzN = Math.round(val*100)/100;
    s.step = "TOPUP_RECEIPT";
    st.set(tgId, s);
    return ctx.reply("2) İndi ödəniş qəbzini foto kimi göndərin.
(Qeyd: Bu MVP-də admin əl ilə təsdiqləyəcək.)");
  });

  // Driver receives ride offers
  bot.action(/ACCEPT_(.+)/, async (ctx) => {
    const rideId = ctx.match[1];
    const user = await upsertDriver(ctx);
    const dp = await prisma.driverProfile.findUnique({ where:{ userId:user.id }});
    if (dp.status !== "APPROVED") return ctx.answerCbQuery("Təsdiqlənməmisiniz.");
    const bal = await getDriverBalance(user.id);
    if (bal <= -15) return ctx.answerCbQuery("Balans limiti: sifariş qəbul edilmir.");

    const ride = await prisma.ride.findUnique({ where:{ id: rideId }});
    if (!ride || ride.status !== "REQUESTED") return ctx.answerCbQuery("Sifariş artıq aktiv deyil.");

    // accept
    const dist = await distanceKm(ride.pickupLat, ride.pickupLng, ride.dropLat, ride.dropLng);
    const fare = calcFare(dist);
    const comm = calcCommission(fare);

    await prisma.ride.update({
      where:{ id: rideId },
      data:{
        status:"ACCEPTED",
        driverId: user.id,
        acceptedAt: new Date(),
        distanceKm: dist,
        fareAzN: fare,
        commissionAzN: comm,
        events:{ create:{ eventType:"ACCEPTED", metaJson: JSON.stringify({ driverTg:user.telegramId }) } }
      }
    });

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`✅ Sifarişi qəbul etdiniz.
Məsafə: ${dist.toFixed(1)} km
Qiymət: ${fare} AZN
Komissiya: ${comm} AZN`, driverMain());

    // navigation link (Waze)
    const wazeUrl = `https://waze.com/ul?ll=${ride.pickupLat}%2C${ride.pickupLng}&navigate=yes`;
    await ctx.reply(`🧭 Waze naviqasiya:
${wazeUrl}`);

    await ctx.answerCbQuery("Qəbul edildi");
  });

  bot.command("loc", async (ctx) => {
    // driver can send location by /loc then location (or just send live location)
    await ctx.reply("Zəhmət olmasa location göndərin (mümkünsə live location).");
  });

  bot.on("location", async (ctx) => {
    const user = await upsertDriver(ctx);
    const loc = ctx.message.location;
    await prisma.driverProfile.update({
      where:{ userId:user.id },
      data:{ lastLat: loc.latitude, lastLng: loc.longitude, lastLocationAt: new Date() }
    });
  });

  bot.command("start_trip", async (ctx) => {
    const user = await upsertDriver(ctx);
    const ride = await prisma.ride.findFirst({ where:{ driverId:user.id, status:"ACCEPTED" }, orderBy:{ acceptedAt:"desc" }});
    if (!ride) return ctx.reply("Aktiv (ACCEPTED) sifariş tapılmadı.");
    await prisma.ride.update({ where:{ id: ride.id }, data:{ status:"STARTED", startedAt:new Date(), events:{ create:{ eventType:"STARTED" } } }});
    await ctx.reply("🟢 Gediş başladı.");
  });

  bot.command("finish_trip", async (ctx) => {
    const user = await upsertDriver(ctx);
    const ride = await prisma.ride.findFirst({ where:{ driverId:user.id, status:"STARTED" }, orderBy:{ startedAt:"desc" }});
    if (!ride) return ctx.reply("Aktiv (STARTED) gediş tapılmadı.");
    const comm = ride.commissionAzN ?? 0;
    await prisma.ride.update({ where:{ id: ride.id }, data:{ status:"COMPLETED", completedAt:new Date(), events:{ create:{ eventType:"COMPLETED" } } }});
    // commission decreases driver balance (driver owes)
    await prisma.balanceLedger.create({ data:{ userId:user.id, amountAzN: -comm, reason:`Komissiya (10%) - Ride ${ride.id}` }});
    await ctx.reply(bigPriceText(ride.fareAzN ?? 0), { parse_mode:"Markdown" });
    await ctx.reply(`✅ Gediş bitdi.
Komissiya balansdan çıxıldı: ${comm} AZN`, driverMain());
  });

  bot.hears("ℹ️ Kömək", async (ctx) => {
    await ctx.reply("Kömək:
- Onlayn olduqda sifarişlər gəlir.
- Gediş başlayanda: /start_trip
- Gediş bitirəndə: /finish_trip
- Balans -15 AZN olarsa sifariş qəbul edilmir.
", driverMain());
  });

  bot.catch((err) => console.error("Driver bot error:", err));
  return bot;
}

module.exports = { createDriverBot };
