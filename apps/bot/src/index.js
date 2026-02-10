import 'dotenv/config';
import express from 'express';
import { Bot, Keyboard } from 'grammy';

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if (!WEBAPP_URL) throw new Error('WEBAPP_URL missing');

const app = express();
app.get('/', (req, res) => res.send('PayTaksi bot alive (V3)'));
app.get('/health', (req, res) => res.json({ ok: true, v: 'V3', ts: new Date().toISOString() }));
app.listen(PORT, () => console.log('HTTP server running on port', PORT));

const bot = new Bot(BOT_TOKEN);

// Reply keyboard WebApp button (THIS is what opens inside Telegram as a Mini App)
const webAppKeyboard = new Keyboard()
  .webApp('🚕 PayTaksi-ni aç (V3)', WEBAPP_URL)
  .resized();

bot.command('start', async (ctx) => {
  await ctx.reply('PayTaksi — sifariş ver / sürücü kimi işlət.', { reply_markup: webAppKeyboard });
  await ctx.reply('Düymə Telegram daxilində açılmalıdır (Google yox).', { reply_markup: webAppKeyboard });
});

bot.command('ping', async (ctx) => {
  await ctx.reply('pong V3');
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

bot.start();
console.log('✅ PayTaksi bot started (WebApp V3).');
