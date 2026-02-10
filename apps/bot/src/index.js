import 'dotenv/config';
import { Bot, InlineKeyboard } from "grammy";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN missing");
const webAppUrl = process.env.WEBAPP_URL || "http://localhost:5173";

const bot = new Bot(token);

bot.command("start", async (ctx) => {
  const kb = new InlineKeyboard().webApp("🚕 PayTaksi-ni aç", webAppUrl);
  await ctx.reply(
    "PayTaksi — sifariş ver / sürücü kimi işlət. Aşağıdan Mini App-i aç:",
    { reply_markup: kb }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply("Əmr: /start — Mini App-i aç");
});

bot.on("message:text", async (ctx) => {
  if (ctx.message.text?.toLowerCase().includes("paytaksi")) {
    const kb = new InlineKeyboard().webApp("🚕 PayTaksi-ni aç", webAppUrl);
    await ctx.reply("Buyur:", { reply_markup: kb });
  }
});

bot.start();
console.log("PayTaksi bot started");
