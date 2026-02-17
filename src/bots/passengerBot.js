const { Telegraf, Markup } = require("telegraf");
const { prisma } = require("../db");
const { passengerMain } = require("./keyboards");
const st = require("./state");

function requireLocation(){
  return Markup.keyboard([["📍 Yerimi göndər"]]).resize().oneTime();
}

async function upsertPassenger(ctx){
  const tgId = String(ctx.from.id);
  let user = await prisma.user.findUnique({ where: { telegramId: tgId } });
  if (!user){
    user = await prisma.user.create({
      data: {
        telegramId: tgId,
        role: "PASSENGER",
        firstName: ctx.from.first_name || null,
        lastName: ctx.from.last_name || null,
      }
    });
    await prisma.passengerProfile.create({ data: { userId: user.id }});
  }
  return user;
}

function createPassengerBot(token, notifyDriversFn){
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    await upsertPassenger(ctx);
    await ctx.reply("Salam! PayTaksi 🚕
Sifariş vermək üçün menyudan istifadə et.", passengerMain());
  });

  bot.hears("🚕 Taksi sifariş et", async (ctx) => {
    const user = await upsertPassenger(ctx);
    st.set(user.telegramId, { step: "PICKUP", data: {} });
    await ctx.reply("1) Zəhmət olmasa *qarşılama ünvanını* göndər.
📍 Location kimi göndər (telefonun “Yer” funksiyası).", { parse_mode:"Markdown", ...requireLocation() });
  });

  bot.on("location", async (ctx) => {
    const tgId = String(ctx.from.id);
    const s = st.get(tgId);
    if (!s) return;

    if (s.step === "PICKUP"){
      s.data.pickup = ctx.message.location;
      s.step = "DROP";
      st.set(tgId, s);
      await ctx.reply("2) İndi *gedəcəyiniz ünvanın* location-nu göndərin.", { parse_mode:"Markdown", ...requireLocation() });
      return;
    }

    if (s.step === "DROP"){
      s.data.drop = ctx.message.location;
      const user = await upsertPassenger(ctx);

      const ride = await prisma.ride.create({
        data: {
          passengerId: user.id,
          pickupLat: s.data.pickup.latitude,
          pickupLng: s.data.pickup.longitude,
          dropLat: s.data.drop.latitude,
          dropLng: s.data.drop.longitude,
          status: "REQUESTED",
          events: { create: { eventType:"REQUESTED" } }
        }
      });

      st.clear(tgId);
      await ctx.reply(`✅ Sifariş yaradıldı.
ID: ${ride.id}
Sürücülərə göndərilir...`, passengerMain());

      await notifyDriversFn(ride.id); // broadcast to eligible drivers
      return;
    }
  });

  bot.hears("👤 Profil", async (ctx) => {
    const user = await upsertPassenger(ctx);
    await ctx.reply(`👤 Profil
Ad: ${user.firstName || "-"}
Soyad: ${user.lastName || "-"}
Telefon: ${user.phone || "-"}
`, passengerMain());
  });

  bot.hears("🧾 Sifarişlərim", async (ctx) => {
    const user = await upsertPassenger(ctx);
    const rides = await prisma.ride.findMany({ where: { passengerId: user.id }, orderBy:{ createdAt:"desc" }, take: 10 });
    if (!rides.length) return ctx.reply("Hələ sifariş yoxdur.", passengerMain());
    const lines = rides.map(r => `• ${r.status} | ${r.fareAzN ?? "-"} AZN | ${r.createdAt.toISOString().slice(0,16).replace("T"," ")}`);
    await ctx.reply("Son 10 sifariş:
" + lines.join("
"), passengerMain());
  });

  bot.hears("ℹ️ Kömək", async (ctx) => {
    await ctx.reply("Kömək:
- 'Taksi sifariş et' → 2 dəfə location göndər.
- Əgər location göndərə bilmirsənsə: Telefon → GPS aç → Telegramda 📎 → Location.
", passengerMain());
  });

  bot.catch((err) => console.error("Passenger bot error:", err));
  return bot;
}

module.exports = { createPassengerBot };
