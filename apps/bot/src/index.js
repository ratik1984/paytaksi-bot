import 'dotenv/config';
import { Bot, InlineKeyboard } from "grammy";
import http from "node:http";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN missing");

const webAppUrl = process.env.WEBAPP_URL || "https://google.com";
const port = Number(process.env.PORT || 10000);

const bot = new Bot(token);

// Telegram commands
bot.command("start", async (ctx) => {
  const kb = new InlineKeyboard().webApp("🚕 PayTaksi-ni aç", webAppUrl);
  await ctx.reply(
    "PayTaksi — sifariş ver / sürücü kimi işlət.",
    { reply_markup: kb }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply("/start — PayTaksi Mini App");
});

// HTTP server (Render Free üçün MÜTLƏQ lazımdır)
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }
  res.writeHead(200);
  res.end("PayTaksi bot running");
});

server.listen(port, "0.0.0.0", () => {
  console.log("HTTP server running on port", port);
});

// Botu polling ilə başladırıq (WEBHOOK YOX)
bot.start();
console.log("PayTaksi bot started (polling mode)");
