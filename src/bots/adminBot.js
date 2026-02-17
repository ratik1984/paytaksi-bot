const { Telegraf, Markup } = require("telegraf");
const bcrypt = require("bcryptjs");
const { prisma } = require("../db");
const { adminMain } = require("./keyboards");

async function ensureAdminFromEnv(){
  // Optional: allow admin panel login without Telegram admin user
  return true;
}

async function isAdminTelegram(ctx){
  const tgId = String(ctx.from.id);
  const u = await prisma.user.findUnique({ where:{ telegramId: tgId }, include:{ adminProfile:true }});
  return !!u?.adminProfile;
}

function createAdminBot(token){
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const ok = await isAdminTelegram(ctx);
    if (!ok){
      return ctx.reply("⛔ Bu bot yalnız admin üçündür.");
    }
    await ctx.reply("Admin panel botu hazırdır.", adminMain());
  });

  bot.hears("🧑‍✈️ Sürücü təsdiqləri", async (ctx) => {
    if (!await isAdminTelegram(ctx)) return;
    const pending = await prisma.driverProfile.findMany({
      where:{ status:"PENDING" },
      include:{ user:true },
      orderBy:{ userId:"asc" },
      take: 10
    });
    if (!pending.length) return ctx.reply("Pending sürücü yoxdur.", adminMain());
    for (const d of pending){
      await ctx.reply(`Sürücü: ${d.user.firstName||""} ${d.user.lastName||""}
TG: ${d.user.telegramId}
Nömrə: ${d.carPlate||"-"}
Model: ${d.carBrandModel||"-"}
Status: ${d.status}`,
        Markup.inlineKeyboard([
          Markup.button.callback("✅ Təsdiqlə", `APPROVE_DRIVER_${d.id}`),
          Markup.button.callback("❌ Rədd et", `REJECT_DRIVER_${d.id}`)
        ])
      );
    }
  });

  bot.action(/APPROVE_DRIVER_(.+)/, async (ctx) => {
    if (!await isAdminTelegram(ctx)) return ctx.answerCbQuery("No admin");
    const id = ctx.match[1];
    const d = await prisma.driverProfile.update({ where:{ id }, data:{ status:"APPROVED" }, include:{ user:true }});
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`✅ Təsdiq edildi: TG ${d.user.telegramId}`);
    await ctx.answerCbQuery("OK");
  });

  bot.action(/REJECT_DRIVER_(.+)/, async (ctx) => {
    if (!await isAdminTelegram(ctx)) return ctx.answerCbQuery("No admin");
    const id = ctx.match[1];
    const d = await prisma.driverProfile.update({ where:{ id }, data:{ status:"REJECTED" }, include:{ user:true }});
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`❌ Rədd edildi: TG ${d.user.telegramId}`);
    await ctx.answerCbQuery("OK");
  });

  bot.hears("➕ Balans yükləmələri", async (ctx) => {
    if (!await isAdminTelegram(ctx)) return;
    const reqs = await prisma.topUpRequest.findMany({
      where:{ status:"PENDING" },
      include:{ user:true },
      orderBy:{ createdAt:"desc" },
      take: 10
    });
    if (!reqs.length) return ctx.reply("Pending yükləmə yoxdur.", adminMain());
    for (const r of reqs){
      await ctx.replyWithPhoto(r.receiptFileId, { caption:`TopUp
TG: ${r.user.telegramId}
Məbləğ: ${r.amountAzN} AZN
ID: ${r.id}` ,
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback("✅ Təsdiqlə", `APPROVE_TOPUP_${r.id}`),
          Markup.button.callback("❌ Rədd et", `REJECT_TOPUP_${r.id}`)
        ]).reply_markup
      });
    }
  });

  bot.action(/APPROVE_TOPUP_(.+)/, async (ctx) => {
    if (!await isAdminTelegram(ctx)) return ctx.answerCbQuery("No admin");
    const id = ctx.match[1];
    const req = await prisma.topUpRequest.findUnique({ where:{ id }, include:{ user:true }});
    if (!req || req.status !== "PENDING") return ctx.answerCbQuery("Not found");
    await prisma.topUpRequest.update({ where:{ id }, data:{ status:"APPROVED", decidedAt:new Date() }});
    await prisma.balanceLedger.create({ data:{ userId:req.userId, amountAzN:req.amountAzN, reason:`TopUp approved (${id})` }});
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`✅ Balans artırıldı: TG ${req.user.telegramId} +${req.amountAzN} AZN`);
    await ctx.answerCbQuery("OK");
  });

  bot.action(/REJECT_TOPUP_(.+)/, async (ctx) => {
    if (!await isAdminTelegram(ctx)) return ctx.answerCbQuery("No admin");
    const id = ctx.match[1];
    await prisma.topUpRequest.update({ where:{ id }, data:{ status:"REJECTED", decidedAt:new Date() }});
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`❌ TopUp rədd edildi: ${id}`);
    await ctx.answerCbQuery("OK");
  });

  bot.hears("ℹ️ Kömək", async (ctx) => {
    if (!await isAdminTelegram(ctx)) return;
    await ctx.reply("Admin bot:
- Sürücü təsdiqləri
- Balans yükləmələri (qəbz)
Daha geniş admin panel: /admin (web).", adminMain());
  });

  bot.catch((err) => console.error("Admin bot error:", err));
  return bot;
}

module.exports = { createAdminBot };
