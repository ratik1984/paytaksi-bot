import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { Server as IOServer } from 'socket.io';
import { makePool } from './db.js';
import { verifyInitData } from './telegram/verifyInitData.js';
import { computeFare } from './pricing.js';
import { rankDrivers } from './matching.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true, credentials: true });
await app.register(jwt, { secret: process.env.JWT_SECRET || 'dev_secret_change_me' });

const pool = makePool();



import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => {
  return { ok: true };
});

app.get('/', async () => {
  return { service: 'PayTaksi API' };
});

const port = process.env.PORT || 8080;

app.listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log('PayTaksi API running on port', port);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });



async function getSetting(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return rows.length ? rows[0].value : String(fallback);
}

async function audit(action, actorUserId = null, meta = {}) {
  await pool.query('INSERT INTO audit_logs(actor_user_id, action, meta) VALUES($1,$2,$3)', [
    actorUserId,
    action,
    meta
  ]);
}

app.post('/auth/telegram', async (req, reply) => {
  const { initData } = req.body || {};
  if (!initData) return reply.code(400).send({ error: 'initData required' });

  const parsed = verifyInitData(initData, process.env.BOT_TOKEN || '');
  if (!parsed || !parsed.user) return reply.code(401).send({ error: 'Invalid initData' });

  const tgId = BigInt(parsed.user.id);
  const name = [parsed.user.first_name, parsed.user.last_name].filter(Boolean).join(' ');
  const username = parsed.user.username || null;

  const isAdmin = String(process.env.ADMIN_TG_ID || '') === String(parsed.user.id);

  const role = isAdmin ? 'admin' : 'passenger';

  const upsert = await pool.query(`
    INSERT INTO users(telegram_id, role, name, username)
    VALUES($1,$2,$3,$4)
    ON CONFLICT (telegram_id) DO UPDATE SET
      name=EXCLUDED.name,
      username=EXCLUDED.username
    RETURNING id, telegram_id, role, name, username, created_at;
  `, [tgId.toString(), role, name || null, username]);

  const user = upsert.rows[0];

  // if admin role, keep it
  if (isAdmin && user.role !== 'admin') {
    await pool.query('UPDATE users SET role=\'admin\' WHERE id=$1', [user.id]);
    user.role = 'admin';
  }

  const token = app.jwt.sign({ uid: user.id, tg: user.telegram_id, role: user.role });

  await audit('auth_telegram', user.id, { telegram_id: user.telegram_id, role: user.role });

  return { token, user };
});

// JWT auth
app.addHook('preHandler', async (req, reply) => {
  const publicPaths = new Set(['/health', '/auth/telegram']);
  if (publicPaths.has(req.routerPath)) return;
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

app.get('/me', async (req) => {
  const { uid } = req.user;
  const { rows } = await pool.query('SELECT id, telegram_id, role, name, username, created_at FROM users WHERE id=$1', [uid]);
  return { user: rows[0] };
});

// Driver apply
app.post('/driver/apply', async (req, reply) => {
  const { uid } = req.user;
  const { car_make, car_model, plate } = req.body || {};

  // promote to driver role
  await pool.query("UPDATE users SET role='driver' WHERE id=$1", [uid]);

  await pool.query(`
    INSERT INTO drivers(user_id, status, car_make, car_model, plate)
    VALUES($1,'pending',$2,$3,$4)
    ON CONFLICT (user_id) DO UPDATE SET car_make=$2, car_model=$3, plate=$4
  `, [uid, car_make || null, car_model || null, plate || null]);

  await audit('driver_apply', uid, { car_make, car_model, plate });
  return { ok: true, status: 'pending' };
});

app.post('/driver/online', async (req, reply) => {
  const { uid } = req.user;
  // must be approved
  const { rows } = await pool.query('SELECT status FROM drivers WHERE user_id=$1', [uid]);
  if (!rows.length) return reply.code(400).send({ error: 'Not a driver' });
  if (rows[0].status !== 'approved') return reply.code(403).send({ error: 'Driver not approved' });

  await pool.query('UPDATE drivers SET is_online=true, last_seen_at=now() WHERE user_id=$1', [uid]);
  await audit('driver_online', uid, {});
  return { ok: true };
});

app.post('/driver/offline', async (req) => {
  const { uid } = req.user;
  await pool.query('UPDATE drivers SET is_online=false WHERE user_id=$1', [uid]);
  await audit('driver_offline', uid, {});
  return { ok: true };
});

app.post('/driver/location', async (req, reply) => {
  const { uid } = req.user;
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return reply.code(400).send({ error: 'lat/lng required' });

  await pool.query('UPDATE drivers SET last_lat=$2, last_lng=$3, last_seen_at=now() WHERE user_id=$1', [uid, lat, lng]);
  await pool.query('INSERT INTO driver_location_logs(driver_id, lat, lng) VALUES($1,$2,$3)', [uid, lat, lng]);

  // broadcast to active trips where this driver is assigned
  io.to(`driver:${uid}`).emit('driver:location:ack', { ok: true });
  io.emit('driver:location', { driver_id: uid, lat, lng, ts: Date.now() });

  return { ok: true };
});

// Trip create (passenger)
app.post('/trip/create', async (req, reply) => {
  const { uid } = req.user;
  const { pickup, dropoff, payment_method='cash', distance_km } = req.body || {};
  if (!pickup || !dropoff) return reply.code(400).send({ error: 'pickup/dropoff required' });

  const startFare = Number(await getSetting('start_fare', 3.50));
  const freeKm = Number(await getSetting('free_km', 3));
  const perKm = Number(await getSetting('per_km', 0.40));

  const estFare = computeFare(Number(distance_km || 0), startFare, freeKm, perKm);

  const { rows } = await pool.query(`
    INSERT INTO trips(passenger_id, pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
      distance_km, fare_estimated, status, payment_method, payment_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'searching',$10,'unpaid')
    RETURNING *;
  `, [
    uid,
    pickup.lat, pickup.lng, pickup.address || null,
    dropoff.lat, dropoff.lng, dropoff.address || null,
    Number(distance_km || 0),
    estFare,
    payment_method
  ]);

  const trip = rows[0];
  await audit('trip_create', uid, { trip_id: trip.id, payment_method });

  // match drivers
  const maxDrivers = Number(await getSetting('max_offer_drivers', 5));
  const offerTimeout = Number(await getSetting('offer_timeout_sec', 20));

  const driversRes = await pool.query(`
    SELECT d.user_id, d.last_lat, d.last_lng
    FROM drivers d
    WHERE d.is_online=true AND d.status='approved' AND d.last_lat IS NOT NULL AND d.last_lng IS NOT NULL
  `);

  const ranked = rankDrivers(driversRes.rows, pickup.lat, pickup.lng).slice(0, maxDrivers);

  for (const d of ranked) {
    await pool.query(`
      INSERT INTO trip_offers(trip_id, driver_id, status)
      VALUES($1,$2,'sent')
      ON CONFLICT (trip_id, driver_id) DO NOTHING
    `, [trip.id, d.user_id]);
    io.to(`driver:${d.user_id}`).emit('trip:offer', { trip, distance_to_pickup_km: d.distance_km, timeout_sec: offerTimeout });
  }

  // passenger room
  io.to(`passenger:${uid}`).emit('trip:created', { trip });

  return { trip, offered_to: ranked.map(d => ({ driver_id: d.user_id, distance_to_pickup_km: d.distance_km })) };
});

app.post('/trip/:id/cancel', async (req, reply) => {
  const { uid, role } = req.user;
  const tripId = req.params.id;

  const t = await pool.query('SELECT * FROM trips WHERE id=$1', [tripId]);
  if (!t.rows.length) return reply.code(404).send({ error: 'Trip not found' });

  const trip = t.rows[0];
  if (role !== 'admin' && trip.passenger_id !== uid) return reply.code(403).send({ error: 'Forbidden' });

  await pool.query("UPDATE trips SET status='cancelled', cancelled_at=now() WHERE id=$1 AND status NOT IN ('completed','cancelled')", [tripId]);
  await pool.query("UPDATE trip_offers SET status='expired', updated_at=now() WHERE trip_id=$1 AND status='sent'", [tripId]);

  io.emit('trip:cancelled', { trip_id: tripId });
  await audit('trip_cancel', uid, { trip_id: tripId });

  return { ok: true };
});

// Driver accept
app.post('/trip/:id/accept', async (req, reply) => {
  const { uid } = req.user;
  const tripId = req.params.id;

  const d = await pool.query('SELECT status FROM drivers WHERE user_id=$1', [uid]);
  if (!d.rows.length || d.rows[0].status !== 'approved') return reply.code(403).send({ error: 'Not an approved driver' });

  const t = await pool.query('SELECT * FROM trips WHERE id=$1', [tripId]);
  if (!t.rows.length) return reply.code(404).send({ error: 'Trip not found' });
  const trip = t.rows[0];
  if (!['searching','offered'].includes(trip.status)) return reply.code(409).send({ error: 'Trip not available' });

  // accept atomically
  await pool.query('BEGIN');
  try {
    const upd = await pool.query(`
      UPDATE trips SET driver_id=$2, status='accepted', accepted_at=now()
      WHERE id=$1 AND status IN ('searching','offered') AND driver_id IS NULL
      RETURNING *;
    `, [tripId, uid]);

    if (!upd.rows.length) {
      await pool.query('ROLLBACK');
      return reply.code(409).send({ error: 'Already accepted' });
    }

    await pool.query(`
      UPDATE trip_offers SET status='accepted', updated_at=now()
      WHERE trip_id=$1 AND driver_id=$2
    `, [tripId, uid]);

    await pool.query(`
      UPDATE trip_offers SET status='expired', updated_at=now()
      WHERE trip_id=$1 AND driver_id<>$2 AND status='sent'
    `, [tripId, uid]);

    await pool.query('COMMIT');

    const acceptedTrip = upd.rows[0];
    io.emit('trip:accepted', { trip: acceptedTrip });
    io.to(`passenger:${acceptedTrip.passenger_id}`).emit('trip:accepted', { trip: acceptedTrip });
    io.to(`driver:${uid}`).emit('trip:accepted', { trip: acceptedTrip });

    await audit('trip_accept', uid, { trip_id: tripId });

    return { trip: acceptedTrip };
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
});

// Driver reject (rating penalty)
app.post('/trip/:id/reject', async (req, reply) => {
  const { uid } = req.user;
  const tripId = req.params.id;

  const penalty = Number(await getSetting('reject_penalty', 0.05));

  await pool.query(`
    UPDATE trip_offers SET status='rejected', updated_at=now()
    WHERE trip_id=$1 AND driver_id=$2 AND status='sent'
  `, [tripId, uid]);

  // rating penalty
  await pool.query(`
    UPDATE drivers SET rating = GREATEST(1.0, rating - $2)
    WHERE user_id=$1
  `, [uid, penalty]);

  io.to(`driver:${uid}`).emit('trip:rejected:ack', { trip_id: tripId, penalty });

  await audit('trip_reject', uid, { trip_id: tripId, penalty });

  return { ok: true, penalty };
});

app.post('/trip/:id/start', async (req, reply) => {
  const { uid, role } = req.user;
  const tripId = req.params.id;

  const t = await pool.query('SELECT * FROM trips WHERE id=$1', [tripId]);
  if (!t.rows.length) return reply.code(404).send({ error: 'Trip not found' });

  const trip = t.rows[0];
  if (role !== 'admin' && trip.driver_id !== uid) return reply.code(403).send({ error: 'Forbidden' });

  const upd = await pool.query("UPDATE trips SET status='in_progress', started_at=now() WHERE id=$1 AND status='accepted' RETURNING *", [tripId]);
  if (!upd.rows.length) return reply.code(409).send({ error: 'Invalid status transition' });

  io.emit('trip:started', { trip: upd.rows[0] });
  await audit('trip_start', uid, { trip_id: tripId });
  return { trip: upd.rows[0] };
});

app.post('/trip/:id/finish', async (req, reply) => {
  const { uid, role } = req.user;
  const tripId = req.params.id;
  const { distance_km } = req.body || {};

  const t = await pool.query('SELECT * FROM trips WHERE id=$1', [tripId]);
  if (!t.rows.length) return reply.code(404).send({ error: 'Trip not found' });

  const trip = t.rows[0];
  if (role !== 'admin' && trip.driver_id !== uid) return reply.code(403).send({ error: 'Forbidden' });

  const startFare = Number(await getSetting('start_fare', 3.50));
  const freeKm = Number(await getSetting('free_km', 3));
  const perKm = Number(await getSetting('per_km', 0.40));

  const finalDist = Number(distance_km ?? trip.distance_km ?? 0);
  const finalFare = computeFare(finalDist, startFare, freeKm, perKm);

  const upd = await pool.query(`
    UPDATE trips SET status='completed', completed_at=now(), distance_km=$2, fare_final=$3
    WHERE id=$1 AND status IN ('in_progress','accepted')
    RETURNING *;
  `, [tripId, finalDist, finalFare]);

  if (!upd.rows.length) return reply.code(409).send({ error: 'Invalid status transition' });

  io.emit('trip:completed', { trip: upd.rows[0] });
  await audit('trip_finish', uid, { trip_id: tripId, finalDist, finalFare });

  return { trip: upd.rows[0] };
});

// Admin APIs
function requireAdmin(req, reply) {
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Admin only' });
}

app.get('/admin/stats', async (req, reply) => {
  const r = requireAdmin(req, reply); if (r) return r;
  const [users, trips, online] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM users'),
    pool.query('SELECT COUNT(*)::int AS c FROM trips'),
    pool.query("SELECT COUNT(*)::int AS c FROM drivers WHERE is_online=true AND status='approved'")
  ]);
  return { users: users.rows[0].c, trips: trips.rows[0].c, onlineDrivers: online.rows[0].c };
});

app.post('/admin/driver/approve', async (req, reply) => {
  const r = requireAdmin(req, reply); if (r) return r;
  const { driver_user_id } = req.body || {};
  if (!driver_user_id) return reply.code(400).send({ error: 'driver_user_id required' });
  await pool.query("UPDATE drivers SET status='approved' WHERE user_id=$1", [driver_user_id]);
  await audit('admin_driver_approve', req.user.uid, { driver_user_id });
  return { ok: true };
});

app.post('/admin/driver/reject', async (req, reply) => {
  const r = requireAdmin(req, reply); if (r) return r;
  const { driver_user_id } = req.body || {};
  if (!driver_user_id) return reply.code(400).send({ error: 'driver_user_id required' });
  await pool.query("UPDATE drivers SET status='rejected' WHERE user_id=$1", [driver_user_id]);
  await audit('admin_driver_reject', req.user.uid, { driver_user_id });
  return { ok: true };
});

app.get('/admin/drivers', async (req, reply) => {
  const r = requireAdmin(req, reply); if (r) return r;
  const { rows } = await pool.query(`
    SELECT u.id, u.telegram_id, u.name, u.username, d.status, d.car_make, d.car_model, d.plate, d.rating, d.is_online
    FROM users u JOIN drivers d ON d.user_id=u.id
    ORDER BY u.created_at DESC
  `);
  return { drivers: rows };
});

app.get('/admin/trips', async (req, reply) => {
  const r = requireAdmin(req, reply); if (r) return r;
  const { rows } = await pool.query(`
    SELECT t.*, pu.name AS passenger_name, du.name AS driver_name
    FROM trips t
    JOIN users pu ON pu.id=t.passenger_id
    LEFT JOIN users du ON du.id=t.driver_id
    ORDER BY t.created_at DESC
    LIMIT 200
  `);
  return { trips: rows };
});

// Create HTTP server and Socket.IO
const server = app.server;
const io = new IOServer(server, { cors: { origin: true, credentials: true } });

io.on('connection', (socket) => {
  // client should send auth JWT
  socket.on('auth', async ({ token }) => {
    try {
      const payload = app.jwt.verify(token);
      socket.data.user = payload;
      socket.join(`${payload.role}:${payload.uid}`);
      if (payload.role === 'driver') socket.join(`driver:${payload.uid}`);
      if (payload.role === 'passenger') socket.join(`passenger:${payload.uid}`);
      socket.emit('auth:ok', { ok: true, payload: { role: payload.role, uid: payload.uid } });
    } catch {
      socket.emit('auth:fail', { ok: false });
    }
  });

  socket.on('joinTrip', ({ tripId }) => {
    socket.join(`trip:${tripId}`);
  });
});

const port = Number(process.env.PORT || 8080);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
