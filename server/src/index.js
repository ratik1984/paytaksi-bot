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

async function main() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('dev'));
  app.use(express.json({ limit: '2mb' }));

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET','POST'] }
  });

  const pool = getPool();
  await initDb(pool);

  // Static webapps
  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/', express.static(publicDir));

  // API
  const bots = {};
  bots.passenger = createPassengerBot({ pool });
  bots.driver = createDriverBot({ pool, getPassengerBot: () => bots.passenger });
  bots.admin = createAdminBot({ pool, getDriverBot: () => bots.driver });

  registerApi(app, { pool, io, bots });
  registerSocket(io, { pool, bots });

  // Launch bots (long polling)
  await bots.passenger.launch();
  await bots.driver.launch();
  await bots.admin.launch();

  process.once('SIGINT', () => {
    bots.passenger.stop('SIGINT');
    bots.driver.stop('SIGINT');
    bots.admin.stop('SIGINT');
    server.close();
  });
  process.once('SIGTERM', () => {
    bots.passenger.stop('SIGTERM');
    bots.driver.stop('SIGTERM');
    bots.admin.stop('SIGTERM');
    server.close();
  });

  const port = process.env.PORT || 10000;
  server.listen(port, () => {
    console.log(`PayTaksi server listening on :${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
