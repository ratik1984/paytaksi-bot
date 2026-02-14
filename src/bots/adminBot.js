import { Telegraf, Markup } from 'telegraf';
import { q } from '../db.js';

export function createAdminBot(appBaseUrl) {
  const token = process.env.ADMIN_BOT_TOKEN;
  if (!token) throw new Error('ADMIN_BOT_TOKEN missing');
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const tgId = ctx.from?.id;
    if (tgId) await q('INSERT INTO bot_users(tg_id, role) VALUES ($1, $2) ON CONFLICT (tg_id) DO UPDATE SET role=$2', [tgId, 'admin']);
    const url = `${appBaseUrl}/app?role=admin`;
    await ctx.reply(
      'PayTaksi 🚕\nAdmin paneli açmaq üçün düyməyə bas.',
      Markup.inlineKeyboard([Markup.button.webApp('⚙️ Admin panel', url)])
    );
  });

  return bot;
}
