import { Telegraf, Markup } from 'telegraf';
import { q } from '../db.js';

export function createDriverBot(appBaseUrl) {
  const token = process.env.DRIVER_BOT_TOKEN;
  if (!token) throw new Error('DRIVER_BOT_TOKEN missing');
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const tgId = ctx.from?.id;
    if (tgId) await q('INSERT INTO bot_users(tg_id, role) VALUES ($1, $2) ON CONFLICT (tg_id) DO UPDATE SET role=$2', [tgId, 'driver']);
    const url = `${appBaseUrl}/app?role=driver`;
    await ctx.reply(
      'PayTaksi 🚕\nSürücü paneli açmaq üçün düyməyə bas.',
      Markup.inlineKeyboard([Markup.button.webApp('🚕 Sürücü paneli', url)])
    );
  });

  bot.command('help', (ctx) => ctx.reply('Komandalar: /start'));

  return bot;
}
