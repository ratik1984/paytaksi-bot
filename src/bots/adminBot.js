import { Telegraf, Markup } from 'telegraf';
import { q } from '../db.js';
import { money2 } from '../utils.js';

export function buildAdminBot() {
  const token = process.env.ADMIN_BOT_TOKEN;
  if (!token) throw new Error('ADMIN_BOT_TOKEN missing');
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const base = process.env.PUBLIC_BASE_URL;
    await ctx.reply(
      `PayTaksi Admin bot ✅\n\n/admin - Admin panel linki\n/topups - Gözləyən qəbzlər\n/drivers - Sürücü siyahısı` +
        (base ? `\n\nAdmin panel: ${base}/admin` : '')
    );
  });

  bot.command('admin', async (ctx) => {
    const base = process.env.PUBLIC_BASE_URL;
    if (!base) return ctx.reply('PUBLIC_BASE_URL env yoxdur.');
    await ctx.reply('Admin panel:', Markup.inlineKeyboard([[Markup.button.url('🧰 Admin paneli aç', `${base}/admin`)]]));
  });

  bot.command('topups', async (ctx) => {
    const res = await q(
      `SELECT t.*, d.first_name, d.last_name, d.phone, d.tg_user_id
       FROM topup_requests t
       JOIN drivers d ON d.id=t.driver_id
       WHERE t.status='pending'
       ORDER BY t.created_at DESC
       LIMIT 10`
    );
    if (!res.rowCount) return ctx.reply('Gözləyən qəbz yoxdur.');
    for (const r of res.rows) {
      await ctx.reply(
        `🧾 Top-up #${r.id}\nSürücü: ${r.first_name || ''} ${r.last_name || ''} (${r.phone || ''})\nMəbləğ: ${money2(r.amount_azn)} ₼\nÜsul: ${r.method}\nStatus: ${r.status}\n\nAdmin paneldən təsdiqləyin.`
      );
    }
  });

  bot.command('drivers', async (ctx) => {
    const res = await q(
      `SELECT id, first_name, last_name, phone, status, online, busy, balance
       FROM drivers
       ORDER BY created_at DESC
       LIMIT 15`
    );
    if (!res.rowCount) return ctx.reply('Sürücü yoxdur.');
    const lines = res.rows.map((d) =>
      `#${d.id} ${d.first_name || ''} ${d.last_name || ''} | ${d.phone || ''} | ${d.status} | ${d.online ? 'ON' : 'OFF'} | bal:${money2(d.balance)}₼`
    );
    await ctx.reply(lines.join('\n'));
  });

  return bot;
}
