import express from "express";
import http from "http";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { CONFIG, assertConfig } from "./config.js";
import { db, migrate } from "./db.js";
import { buildBot } from "./bot.js";
import { buildApi } from "./api.js";
import { wireSocket } from "./socket.js";

assertConfig();
migrate();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
if (CONFIG.TRUST_PROXY) app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false, // because we use CDNs in MVP
}));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

app.get("/health", (req,res)=>res.json({ ok:true }));

// Serve web apps
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});
wireSocket(io);

// API
app.use("/api", buildApi({ io }));

// Telegram webhook endpoint
const bot = buildBot();
if (bot) {
  app.post(`/bot/${CONFIG.WEBHOOK_SECRET}`, (req, res) => {
    bot.handleUpdate(req.body, res).catch((err)=> {
      console.error("bot handleUpdate error", err);
      res.status(200).end();
    });
  });
}

async function ensureWebhook() {
  if (!bot) return;
  if (!CONFIG.PUBLIC_BASE_URL) return;

  const webhookUrl = `${CONFIG.PUBLIC_BASE_URL}/bot/${CONFIG.WEBHOOK_SECRET}`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log("[BOT] webhook set:", webhookUrl);
  } catch (e) {
    console.error("[BOT] setWebhook failed:", e?.message || e);
  }
}

ensureWebhook();

server.listen(CONFIG.PORT, () => {
  console.log(`PayTaksi running on :${CONFIG.PORT}`);
});
