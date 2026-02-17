const { Telegraf } = require('telegraf');

async function isSuperAdmin(ctx) {
  return String(ctx.from.id) === String(process.env.SUPER_ADMIN_ID);
}

function createAdminBot({ pool, getDriverBot }) {
  const token = process.env.ADMIN_BOT_TOKEN;
  if (!token) throw new Error('ADMIN_BOT_TOKEN missing');
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    if (!(await isSuperAdmin(ctx))) return ctx.reply('❌ İcazə yoxdur');
    const tgId = ctx.from.id;
    const url = `${process.env.APP_BASE_URL}/a/?tg_id=${tgId}`;
    await ctx.reply('🛠 PayTaksi Admin panel:', {
      reply_markup: {
        keyboard: [[{ text: '🛠 Admin Panel', web_app: { url } }], ['📋 Pending sürücülər']],
        resize_keyboard: true
      }
    });
  });

  bot.hears('📋 Pending sürücülər', async (ctx) => {
    if (!(await isSuperAdmin(ctx))) return;
    const r = await pool.query(
      `SELECT u.telegram_id, u.first_name, u.last_name, u.phone_e164, d.car_make, d.car_model, d.car_color
       FROM drivers d JOIN users u ON u.id=d.user_id WHERE d.status='pending' ORDER BY d.created_at ASC LIMIT 20`
    );
    if (r.rows.length === 0) return ctx.reply('Pending sürücü yoxdur.');

    for (const x of r.rows) {
      await ctx.reply(
        `👤 ${x.first_name || ''} ${x.last_name || ''}\n📞 ${x.phone_e164 || ''}\n🚗 ${x.car_make || ''} ${x.car_model || ''} (${x.car_color || ''})\nTG: ${x.telegram_id}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Təsdiqlə', callback_data: `approve:${x.telegram_id}` },
              { text: '❌ Rədd et', callback_data: `reject:${x.telegram_id}` }
            ]]
          }
        }
      );
    }
  });

  bot.on('callback_query', async (ctx) => {
    if (!(await isSuperAdmin(ctx))) {
      await ctx.answerCbQuery('No access');
      return;
    }
    const data = ctx.callbackQuery.data || '';
    const [action, tgStr] = data.split(':');
    const driverTg = Number(tgStr);

    if (!driverTg) {
      await ctx.answerCbQuery('Bad data');
      return;
    }

    const u = await pool.query('SELECT id FROM users WHERE telegram_id=$1', [driverTg]);
    const userId = u.rows[0]?.id;
    if (!userId) {
      await ctx.answerCbQuery('Driver not found');
      return;
    }

    if (action === 'approve') {
      await pool.query("UPDATE drivers SET status='approved', approved_at=NOW() WHERE user_id=$1", [userId]);
      await ctx.answerCbQuery('Approved');
      try {
        const driverBot = getDriverBot();
        await driverBot.telegram.sendMessage(driverTg, '✅ Sən təsdiqləndin! /start yaz və panelə keç.');
      } catch (e) {}
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Təsdiqləndi', callback_data: 'noop' }]] }); } catch (e) {}
      return;
    }

    if (action === 'reject') {
      await pool.query("UPDATE drivers SET status='rejected', approved_at=NULL WHERE user_id=$1", [userId]);
      await ctx.answerCbQuery('Rejected');
      try {
        const driverBot = getDriverBot();
        await driverBot.telegram.sendMessage(driverTg, '❌ Sürücü müraciətin rədd edildi.');
      } catch (e) {}
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '❌ Rədd edildi', callback_data: 'noop' }]] }); } catch (e) {}
      return;
    }

    await ctx.answerCbQuery();
  });

  bot.catch((err) => console.error('Admin bot error', err));
  return bot;
}

module.exports = { createAdminBot };
