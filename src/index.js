import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

import { initDb } from './db/db.js';
import { makeBot } from './telegram/bot.js';
import { verifyWebhookSecret, verifyWebAppInitData } from './telegram/verify.js';
import { authMiddleware, issueTokenForTelegramUser } from './web/auth.js';
import { apiRouter } from './web/routes.js';
import { attachSocket } from './web/socket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'paytaksi_bot';

if (!process.env.BOT_TOKEN) {
  console.warn('⚠️ BOT_TOKEN is missing. Bot/webhook will not work until you set it.');
}
if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL is missing. App will not start without a Postgres database.');
}
if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET is missing. Please set it in env.');
}

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // Leaflet + Telegram WebApp scripts
}));
app.use(cors());
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({ windowMs: 60_000, limit: 240 }));

// Static
app.use('/static', express.static(path.join(__dirname, '../public'), { maxAge: '1h' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Telegram webhook
app.post(`/webhook/${WEBHOOK_SECRET}`, verifyWebhookSecret(WEBHOOK_SECRET), async (req, res) => {
  const bot = req.app.locals.bot;
  if (!bot) return res.status(503).json({ ok: false, error: 'bot_not_ready' });
  try {
    await bot.handleUpdate(req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ ok: false });
  }
});

// Auth: exchange Telegram WebApp initData -> JWT
app.post('/api/auth/webapp', async (req, res) => {
  const { initData } = req.body || {};
  try {
    const user = verifyWebAppInitData(initData, process.env.BOT_TOKEN);
    const token = issueTokenForTelegramUser(user);
    res.json({ ok: true, token, user });
  } catch (e) {
    res.status(401).json({ ok: false, error: e?.message || 'auth_failed' });
  }
});

// API (protected)
app.use('/api', authMiddleware, apiRouter);

// WebApp entry points
app.get(['/', '/rider', '/driver', '/admin', '/rider/*', '/driver/*', '/admin/*'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/app/index.html'));
});

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Attach DB + sockets
const db = await initDb();
app.locals.db = db;
attachSocket(io, db);

// Bot
const bot = process.env.BOT_TOKEN ? makeBot({ baseUrl: PUBLIC_BASE_URL }) : null;
app.locals.bot = bot;

httpServer.listen(PORT, async () => {
  console.log(`✅ PayTaksi running on ${PUBLIC_BASE_URL} (port ${PORT})`);

  // Set webhook (best-effort)
  if (bot && PUBLIC_BASE_URL.startsWith('https://')) {
    try {
      await bot.api.setWebhook(`${PUBLIC_BASE_URL}/webhook/${WEBHOOK_SECRET}`);
      console.log('🔗 Telegram webhook set.');
    } catch (e) {
      console.warn('⚠️ Could not set webhook automatically. Set it manually via BotFather/API.', e?.description || e?.message || e);
    }
  } else {
    console.log('ℹ️ Running without webhook auto-setup (need HTTPS + BOT_TOKEN).');
  }
});
