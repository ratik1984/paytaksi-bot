import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { Server as IOServer } from 'socket.io';
import { makePool } from './db.js';
import { computeFare } from './pricing.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: true });
await app.register(jwt, { secret: process.env.JWT_SECRET || 'dev_secret_change_me' });

const pool = makePool();

// ✅ Health endpoint (Render test)
app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));
app.get('/', async () => ({ service: 'PayTaksi API', ok: true }));

// --- Minimal auth (no Telegram initData validation here to keep it simple/stable for your Render test) ---
// You can extend later. For now we keep API booting and routes working.

app.post('/auth/dev', async (req) => {
  const { telegram_id = 0, role = 'admin' } = req.body || {};
  const upsert = await pool.query(`
    INSERT INTO users(telegram_id, role, name, username)
    VALUES($1,$2,'Dev User','dev')
    ON CONFLICT (telegram_id) DO UPDATE SET role=EXCLUDED.role
    RETURNING id, telegram_id, role, name, username;
  `, [String(telegram_id || 1), role]);

  const user = upsert.rows[0];
  const token = app.jwt.sign({ uid: user.id, role: user.role, tg: user.telegram_id });
  return { token, user };
});

// JWT auth hook
app.addHook('preHandler', async (req, reply) => {
  const publicPaths = new Set(['/health', '/', '/auth/dev']);
  if (publicPaths.has(req.routerPath)) return;
  try { await req.jwtVerify(); }
  catch { return reply.code(401).send({ error: 'Unauthorized' }); }
});

app.get('/me', async (req) => {
  const { uid } = req.user;
  const { rows } = await pool.query('SELECT id, telegram_id, role, name, username, created_at FROM users WHERE id=$1', [uid]);
  return { user: rows[0] };
});

// Example fare endpoint
app.get('/fare', async (req) => {
  const d = Number(req.query?.distance_km || 0);
  return { distance_km: d, fare: computeFare(d) };
});

// Socket.IO
const server = app.server;
const io = new IOServer(server, { cors: { origin: true, credentials: true } });
io.on('connection', (socket) => {
  socket.emit('hello', { ok: true });
});

const port = Number(process.env.PORT || 8080);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
