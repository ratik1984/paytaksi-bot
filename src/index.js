import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';

import { initDb } from './db.js';
import { buildAdminRouter } from './admin.js';
import { buildPassengerBot } from './bots/passengerBot.js';
import { buildDriverBot } from './bots/driverBot.js';
import { buildAdminBot } from './bots/adminBot.js';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.resolve('./views'));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'paytaksi_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

// Health
app.get('/', (req, res) => res.send('PayTaksi OK'));

// Init DB
const schemaPath = path.resolve('./sql/schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');
await initDb(schemaSql);

// Bots
const adminBot = buildAdminBot();

// Create passenger bot first, with a driver API holder (set after driver bot is created)
const driverApiHolder = {
  sendMessage: () => {
    throw new Error('Driver bot API not ready');
  },
};
const passengerBot = buildPassengerBot(driverApiHolder);
const driverBot = buildDriverBot(passengerBot.telegram);
driverApiHolder.sendMessage = (...args) => driverBot.telegram.sendMessage(...args);

// webhook endpoints
function webhookPath(kind) {
  // simple obfuscation by token prefix
  const t = {
    passenger: process.env.PASSENGER_BOT_TOKEN,
    driver: process.env.DRIVER_BOT_TOKEN,
    admin: process.env.ADMIN_BOT_TOKEN,
  }[kind];
  const safe = (t || '').split(':')[0] || kind;
  return `/webhook/${kind}/${safe}`;
}

app.use(webhookPath('passenger'), passengerBot.webhookCallback(webhookPath('passenger')));
app.use(webhookPath('driver'), driverBot.webhookCallback(webhookPath('driver')));
app.use(webhookPath('admin'), adminBot.webhookCallback(webhookPath('admin')));

// Admin panel
app.use('/admin', buildAdminRouter());

// Start server
const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  const base = process.env.PUBLIC_BASE_URL;
  console.log(`PayTaksi server on :${port}`);

  // Set webhook if PUBLIC_BASE_URL provided
  if (base) {
    try {
      await passengerBot.telegram.setWebhook(base + webhookPath('passenger'));
      await driverBot.telegram.setWebhook(base + webhookPath('driver'));
      await adminBot.telegram.setWebhook(base + webhookPath('admin'));
      console.log('Webhooks set');
    } catch (e) {
      console.error('Webhook set failed:', e.message);
    }
  } else {
    console.log('PUBLIC_BASE_URL not set; webhooks not configured.');
  }
});
