import { Telegraf, Markup } from "telegraf";
import { CONFIG } from "./config.js";

export function buildBot() {
  if (!CONFIG.BOT_TOKEN) return null;
  const bot = new Telegraf(CONFIG.BOT_TOKEN);

  const passengerUrl = `${CONFIG.PUBLIC_BASE_URL}/p/`;
  const driverUrl = `${CONFIG.PUBLIC_BASE_URL}/d/`;
  const adminUrl = `${CONFIG.PUBLIC_BASE_URL}/admin/`;

  bot.start(async (ctx) => {
    const isAdmin = CONFIG.ADMIN_IDS.includes(ctx.from?.id);
await ctx.reply(
  `🚕 PayTaksi — mini app.

Seçim edin:`,
  Markup.inlineKeyboard([
    [Markup.button.webApp("🧍‍♂️ Sərnişin tətbiqi", passengerUrl)],
    [Markup.button.webApp("🚗 Sürücü tətbiqi", driverUrl)],
    ...(isAdmin ? [[Markup.button.webApp("🛠 Admin panel", adminUrl)]] : []),
  ])
);

  });

  bot.command("passenger", (ctx) => ctx.reply("Sərnişin tətbiqi:", Markup.inlineKeyboard([
    [Markup.button.webApp("Aç", passengerUrl)]
  ])));

  bot.command("driver", (ctx) => ctx.reply("Sürücü tətbiqi:", Markup.inlineKeyboard([
    [Markup.button.webApp("Aç", driverUrl)]
  ])));

  bot.command("admin", (ctx) => {
    const isAdmin = CONFIG.ADMIN_IDS.includes(ctx.from?.id);
    if (!isAdmin) return ctx.reply("Bu bölmə yalnız admin üçündür.");
    return ctx.reply("Admin panel:", Markup.inlineKeyboard([[Markup.button.webApp("Aç", adminUrl)]]));
  });

  bot.on("message", async (ctx) => {
    // gentle help
    if (ctx.message?.text?.toLowerCase?.().includes("help")) {
      return ctx.reply("Komandalar: /start, /passenger, /driver, /admin");
    }
  });

  return bot;
}
