import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { createPassengerBot } from './src/bots/passengerBot.js';
import { createDriverBot } from './src/bots/driverBot.js';
import { createAdminBot } from './src/bots/adminBot.js';
import { registerWebhook } from './src/webhook.js';
import { apiRouter } from './src/routes/api.js';
import { q } from './src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 10000;
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  console.warn('WEBHOOK_SECRET missing. Set it in Render Environment.');
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// serve mini app
app.use('/app', express.static(path.join(__dirname, 'src', 'webapp')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'src', 'webapp', 'index.html')));

// instantiate bots
const passengerBot = createPassengerBot(APP_BASE_URL || `http://localhost:${PORT}`);
const driverBot = createDriverBot(APP_BASE_URL || `http://localhost:${PORT}`);
const adminBot = createAdminBot(APP_BASE_URL || `http://localhost:${PORT}`);

const bots = { passenger: passengerBot, driver: driverBot, admin: adminBot };

// Webhook handlers (POST only)
function webhookPath(role) {
  return `/webhook/${WEBHOOK_SECRET}/${role}`;
}

app.post(webhookPath('passenger'), (req, res) => passengerBot.handleUpdate(req.body, res));
app.post(webhookPath('driver'), (req, res) => driverBot.handleUpdate(req.body, res));
app.post(webhookPath('admin'), (req, res) => adminBot.handleUpdate(req.body, res));

// Helpful GET response (avoid confusion)
app.get('/webhook', (_req, res) => res.status(200).send('OK'));
app.get('/webhook/:secret/:role', (_req, res) => res.status(200).send('OK'));

// API
app.use('/api', apiRouter({ bots }));

// bootstrap
app.listen(PORT, async () => {
  console.log(`PayTaksi server listening on ${PORT}`);

  // DB smoke test
  try {
    await q('SELECT 1', []);
    console.log('DB OK');
  } catch (e) {
    console.error('DB ERROR', e?.message || e);
  }

  if (!APP_BASE_URL) {
    console.warn('APP_BASE_URL missing. Webhooks will not be registered automatically.');
    return;
  }
  if (!WEBHOOK_SECRET) {
    console.warn('WEBHOOK_SECRET missing. Webhooks will not be registered automatically.');
    return;
  }

  try {
    const p = await registerWebhook(passengerBot, webhookPath('passenger'), APP_BASE_URL);
    const d = await registerWebhook(driverBot, webhookPath('driver'), APP_BASE_URL);
    const a = await registerWebhook(adminBot, webhookPath('admin'), APP_BASE_URL);
    console.log('Webhooks set:', { passenger: p, driver: d, admin: a });
  } catch (e) {
    console.error('Failed to set webhooks', e?.message || e);
  }
});
