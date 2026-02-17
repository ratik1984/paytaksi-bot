require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const { Server } = require('socket.io');

const { getPool, initDb } = require('./db');
const { createPassengerBot } = require('./bots/passenger');
const { createDriverBot } = require('./bots/driver');
const { createAdminBot } = require('./bots/admin');
const { registerApi } = require('./api/routes');
const { registerSocket } = require('./realtime/socket');

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function main() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('dev'));
  app.use(express.json({ limit: '2mb' }));

  // Health check (Render expects an open port)
  app.get('/health', (req, res) => res.status(200).send('ok'));

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Start listening ASAP so Render detects the port even if bots/DB have issues.
  const port = process.env.PORT || 10000;
  server.listen(port, () => {
    console.log(`PayTaksi server listening on :${port}`);
  });

  const pool = getPool();
  await initDb(pool);

  // Static webapps
  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/', express.static(publicDir));

  // Create bots
  const bots = {};
  bots.passenger = createPassengerBot({ pool });
  bots.driver = createDriverBot({ pool, getPassengerBot: () => bots.passenger });
  bots.admin = createAdminBot({ pool, getDriverBot: () => bots.driver });

  // API + realtime
  registerApi(app, { pool, io, bots });
  registerSocket(io, { pool, bots });

  // --- Telegram webhooks (fixes getUpdates conflict on Render) ---
  // IMPORTANT:
  // - APP_BASE_URL must be your public HTTPS domain (e.g. https://paytaksi-telegram.onrender.com)
  // - WEBHOOK_SECRET should be a long random string
  const baseUrl = mustGetEnv('APP_BASE_URL').replace(/\/$/, '');
  const secret = (process.env.WEBHOOK_SECRET || 'paytaksi').replace(/[^a-zA-Z0-9_-]/g, '');

  const hookPassenger = `/tg/${secret}/passenger`;
  const hookDriver = `/tg/${secret}/driver`;
  const hookAdmin = `/tg/${secret}/admin`;

  // Mount webhook handlers
  // IMPORTANT: Do NOT mount with app.use(path, ...) here.
  // Telegraf's webhookCallback(path) already checks the path internally.
  // When mounted with Express at a sub-path, Express strips the mount prefix
  // (req.url becomes '/'), causing Telegraf to return 404.
  app.use(bots.passenger.webhookCallback(hookPassenger));
  app.use(bots.driver.webhookCallback(hookDriver));
  app.use(bots.admin.webhookCallback(hookAdmin));

  // Register webhooks (overwrites previous webhook; also stops the need for polling)
  await bots.passenger.telegram.setWebhook(`${baseUrl}${hookPassenger}`);
  await bots.driver.telegram.setWebhook(`${baseUrl}${hookDriver}`);
  await bots.admin.telegram.setWebhook(`${baseUrl}${hookAdmin}`);

  console.log('Webhooks set:');
  console.log(`- passenger: ${baseUrl}${hookPassenger}`);
  console.log(`- driver:    ${baseUrl}${hookDriver}`);
  console.log(`- admin:     ${baseUrl}${hookAdmin}`);

  // Graceful shutdown
  process.once('SIGINT', () => {
    server.close();
  });
  process.once('SIGTERM', () => {
    server.close();
  });
}

main().catch((e) => {
  console.error(e);
  // Do NOT crash the process hard; keep port open so Render is happy.
  // If DB/bots failed, logs will show the error and you can fix env values.
});
