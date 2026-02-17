import { Telegraf, Markup } from 'telegraf';
import { cfg } from '../config.js';
import { q } from '../db.js';
import { bumpDriverBalance } from '../utils/dbHelpers.js';

function isAdmin(ctx) {
  return ctx.from && Number(ctx.from.id) === Number(cfg.superAdminId);
}

export function buildAdminBot() {
  const bot = new Telegraf(cfg.adminBotToken);

  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx)) {
      // silently ignore
      return;
    }
    return next();
  });

  bot.start((ctx) =>
    ctx.reply(
      `PayTaksi Admin 🛠\n\nWeb panel: ${cfg.appBaseUrl}/admin\n\nKomandalar:\n/pending_drivers\n/pending_topups\n/approve_driver USER_ID\n/reject_driver USER_ID\n/approve_topup TOPUP_ID\n/reject_topup TOPUP_ID`
    )
  );

  bot.command('pending_drivers', async (ctx) => {
    const r = await q(
      `SELECT u.id,u.tg_id,u.first_name,u.last_name,u.phone, d.car_make,d.car_model,d.car_plate,d.status
       FROM users u JOIN driver_profiles d ON d.user_id=u.id
       WHERE d.status='pending'
       ORDER BY u.id DESC LIMIT 20`
    );
    if (!r.rows.length) return ctx.reply('Pending sürücü yoxdur.');
    const lines = r.rows.map(
      (x) => `USER_ID ${x.id} • tg:${x.tg_id} • ${x.first_name || ''} ${x.last_name || ''} • ${x.phone || ''} • ${x.car_make || ''} ${x.car_model || ''} • ${x.car_plate || ''}`
    );
    return ctx.reply(lines.join('\n'));
  });

  bot.command('pending_topups', async (ctx) => {
    const r = await q(
      `SELECT t.id,u.id as user_id,u.tg_id,u.first_name,u.last_name,t.method,t.amount_azn,t.status
       FROM topup_requests t
       JOIN users u ON u.id=t.driver_id
       WHERE t.status='pending'
       ORDER BY t.id DESC LIMIT 20`
    );
    if (!r.rows.length) return ctx.reply('Pending topup yoxdur.');
    const lines = r.rows.map(
      (x) => `TOPUP ${x.id} • USER_ID ${x.user_id} • tg:${x.tg_id} • ${x.first_name || ''} ${x.last_name || ''} • ${x.method} • ${Number(x.amount_azn).toFixed(2)} AZN`
    );
    return ctx.reply(lines.join('\n'));
  });

  bot.command('approve_driver', async (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const id = Number(parts[1]);
    if (!id) return ctx.reply('İstifadə: /approve_driver USER_ID');
    await q("UPDATE driver_profiles SET status='approved', updated_at=NOW() WHERE user_id=$1", [id]);
    const u = await q('SELECT tg_id FROM users WHERE id=$1', [id]);
    const tg = u.rows[0]?.tg_id;
    if (tg) await bot.telegram.sendMessage(tg, '✅ Sürücü profiliniz təsdiqləndi. /start yazıb onlayn ola bilərsiniz.');
    return ctx.reply('OK');
  });

  bot.command('reject_driver', async (ctx) => {
    const id = Number(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('İstifadə: /reject_driver USER_ID');
    await q("UPDATE driver_profiles SET status='rejected', updated_at=NOW() WHERE user_id=$1", [id]);
    return ctx.reply('OK');
  });

  bot.command('approve_topup', async (ctx) => {
    const topupId = Number(ctx.message.text.split(' ')[1]);
    if (!topupId) return ctx.reply('İstifadə: /approve_topup TOPUP_ID');

    const r = await q('SELECT * FROM topup_requests WHERE id=$1', [topupId]);
    const t = r.rows[0];
    if (!t) return ctx.reply('Tapılmadı');
    if (t.status !== 'pending') return ctx.reply('Bu sorğu artıq emal olunub.');

    await q("UPDATE topup_requests SET status='approved', updated_at=NOW() WHERE id=$1", [topupId]);
    const next = await bumpDriverBalance(Number(t.driver_id), Number(t.amount_azn), 'topup', { topupId, method: t.method });

    const u = await q('SELECT tg_id FROM users WHERE id=$1', [t.driver_id]);
    const tg = u.rows[0]?.tg_id;
    if (tg) await bot.telegram.sendMessage(tg, `✅ Balans artırıldı: +${Number(t.amount_azn).toFixed(2)} AZN\nYeni balans: ${Number(next).toFixed(2)} AZN`);

    return ctx.reply('OK');
  });

  bot.command('reject_topup', async (ctx) => {
    const topupId = Number(ctx.message.text.split(' ')[1]);
    if (!topupId) return ctx.reply('İstifadə: /reject_topup TOPUP_ID');
    await q("UPDATE topup_requests SET status='rejected', updated_at=NOW() WHERE id=$1", [topupId]);
    return ctx.reply('OK');
  });

  return bot;
}
