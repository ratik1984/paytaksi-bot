import 'dotenv/config';
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import http from "node:http";
import crypto from "node:crypto";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN missing");

const webAppUrl = process.env.WEBAPP_URL || "http://localhost:5173";
const port = Number(process.env.PORT || 10000);

// Optional: use webhook instead of long polling on Render (recommended).
// If WEBHOOK_URL is set, bot will use webhook mode.
// Example: WEBHOOK_URL=https://paytaksi-bot.onrender.com
const webhookUrl = process.env.WEBHOOK_URL || "";

// A secret path token so random people can't hit your webhook endpoint
const webhookSecret = process.env.WEBHOOK_SECRET || crypto.randomBytes(16).toString("hex");
const webhookPath = `/telegram/webhook/${webhookSecret}`;

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

// --- HTTP server (to satisfy Render Web Service free plan: must open a port) ---
const handleUpdate = webhookCallback(bot, "http");

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: webhookUrl ? "webhook" : "polling" }));
      return;
    }

    if (webhookUrl && req.url === webhookPath) {
      // grammY will read the request body and process update
      return handleUpdate(req, res);
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.listen(port, "0.0.0.0", async () => {
  console.log(`PayTaksi bot HTTP listening on :${port}`);
  if (webhookUrl) {
    const fullHook = webhookUrl.replace(/\/$/, "") + webhookPath;
    await bot.api.setWebhook(fullHook);
    console.log("Webhook set to:", fullHook);
    console.log("WEBHOOK_SECRET (save this):", webhookSecret);
    console.log("PayTaksi bot started (webhook mode)");
  } else {
    // Long polling mode (works, but Render free sleeps if not pinged)
    bot.start();
    console.log("PayTaksi bot started (polling mode)");
  }
});
