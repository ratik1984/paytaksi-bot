const { Telegraf } = require('telegraf');

function createPassengerBot({ pool }) {
  const token = process.env.PASSENGER_BOT_TOKEN;
  if (!token) throw new Error('PASSENGER_BOT_TOKEN missing');
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const tgId = ctx.from.id;
    const url = `${process.env.APP_BASE_URL}/p/?tg_id=${tgId}`;
    await ctx.reply('🚕 PayTaksi — Sifariş ver', {
      reply_markup: {
        keyboard: [[{ text: '🚕 Sifariş ver', web_app: { url } }]],
        resize_keyboard: true
      }
    });
  });

  bot.command('panel', async (ctx) => {
    const tgId = ctx.from.id;
    const url = `${process.env.APP_BASE_URL}/p/?tg_id=${tgId}`;
    await ctx.reply('Panel açılır:', { reply_markup: { inline_keyboard: [[{ text: 'Paneli aç', web_app: { url } }]] } });
  });

  bot.catch((err) => console.error('Passenger bot error', err));
  return bot;
}

module.exports = { createPassengerBot };
