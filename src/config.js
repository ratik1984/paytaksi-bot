import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  NODE_ENV: process.env.NODE_ENV || "production",
  PORT: Number(process.env.PORT || 3000),
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "paytaksi_bot",
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  ADMIN_IDS: (process.env.ADMIN_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => Number(s))
    .filter(n => Number.isFinite(n)),
  SQLITE_PATH: process.env.SQLITE_PATH || "./data/app.db",
  TRUST_PROXY: process.env.TRUST_PROXY === "1",
};

export function assertConfig() {
  const missing = [];
  if (!CONFIG.BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!CONFIG.PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL");
  if (missing.length) {
    console.warn("[WARN] Missing env:", missing.join(", "));
    console.warn("The web app will still run, but Telegram webhook auto-setup may not work.");
  }
}
