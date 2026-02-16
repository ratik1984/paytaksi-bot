require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');

const { pool } = require('./src/db');
const { initDb } = require('./src/initDb');
const { signToken, authMiddleware } = require('./src/auth');
const { haversineKm, routeDistanceKm } = require('./src/geo');
const { getPricing, calcFare } = require('./src/pricing');
const { setupBots } = require('./src/bots');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// HTTP + Socket.IO first (so we can use `io` inside routes)
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    // { role: 'passenger'|'driver', id }
    if (!data?.role || !data?.id) return;
    socket.join(`${data.role}:${data.id}`);
  });
});

// Static (Telegram WebApp)
app.use('/passenger', express.static(path.join(__dirname, 'public', 'passenger')));
app.use('/driver', express.static(path.join(__dirname, 'public', 'driver')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

app.get('/health', (req, res) => res.json({ ok: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Passenger auth
app.post('/api/passenger/register', async (req, res) => {
  try {
    const { first_name, last_name, phone, password, tg_id } = req.body;
    if (!first_name || !last_name || !phone || !password) return res.status(400).json({ error: 'Missing fields' });
    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO passengers (first_name,last_name,phone,password_hash,tg_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [first_name, last_name, phone, password_hash, tg_id || null]
    );
    const token = signToken({ role: 'passenger', id: rows[0].id });
    res.json({ token });
  } catch (e) {
    if ((e.message || '').includes('duplicate')) return res.status(409).json({ error: 'Phone already used' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/passenger/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const { rows } = await pool.query('SELECT id, password_hash FROM passengers WHERE phone=$1', [phone]);
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signToken({ role: 'passenger', id: u.id });
    res.json({ token });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Driver auth
app.post('/api/driver/register', async (req, res) => {
  try {
    const { first_name, last_name, phone, password, tg_id, car } = req.body;
    if (!first_name || !last_name || !phone || !password || !car) return res.status(400).json({ error: 'Missing fields' });
    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO drivers (first_name,last_name,phone,password_hash,tg_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [first_name, last_name, phone, password_hash, tg_id || null]
    );
    const driverId = rows[0].id;
    await pool.query(
      'INSERT INTO cars (driver_id,brand,model,year,plate_number,photo_url) VALUES ($1,$2,$3,$4,$5,$6)',
      [driverId, car.brand, car.model, Number(car.year || 0), car.plate_number, car.photo_url || null]
    );
    const token = signToken({ role: 'driver', id: driverId });
    res.json({ token });
  } catch (e) {
    if ((e.message || '').includes('duplicate')) return res.status(409).json({ error: 'Phone already used' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/driver/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const { rows } = await pool.query('SELECT id, password_hash, is_approved FROM drivers WHERE phone=$1', [phone]);
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signToken({ role: 'driver', id: u.id });
    res.json({ token, is_approved: u.is_approved });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/driver/upload_doc', authMiddleware('driver'), upload.single('file'), async (req, res) => {
  try {
    const { doc_type } = req.body;
    if (!doc_type || !req.file) return res.status(400).json({ error: 'Missing' });

    // Demo storage: base64 data URL in DB (production: use S3/Cloudinary)
    const b64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype || 'image/jpeg';
    const dataUrl = `data:${mime};base64,${b64}`;

    await pool.query(
      'INSERT INTO driver_documents (driver_id, doc_type, photo_url) VALUES ($1,$2,$3)',
      [req.user.id, doc_type, dataUrl]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Driver online + location
app.post('/api/driver/set_online', authMiddleware('driver'), async (req, res) => {
  try {
    const { is_online } = req.body;
    await pool.query('UPDATE drivers SET is_online=$1, last_seen=NOW() WHERE id=$2', [!!is_online, req.user.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/driver/update_location', authMiddleware('driver'), async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (lat == null || lng == null) return res.status(400).json({ error: 'Missing' });
    await pool.query(
      'UPDATE drivers SET last_lat=$1, last_lng=$2, last_seen=NOW() WHERE id=$3',
      [Number(lat), Number(lng), req.user.id]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Passenger create trip
app.post('/api/trips/create', authMiddleware('passenger'), async (req, res) => {
  try {
    const { pickup, drop, payment_method } = req.body;
    if (!pickup || !drop) return res.status(400).json({ error: 'Missing' });

    const distKm = await routeDistanceKm(pickup, drop);
    const pricing = await getPricing();
    const money = calcFare(distKm, pricing);

    const { rows } = await pool.query(
      `INSERT INTO trips (passenger_id, pickup_lat, pickup_lng, drop_lat, drop_lng, distance_km, fare, commission, driver_earn, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SEARCHING')
       RETURNING id, passenger_id, distance_km, fare, commission, driver_earn, status`,
      [
        req.user.id,
        Number(pickup.lat), Number(pickup.lng),
        Number(drop.lat), Number(drop.lng),
        distKm,
        money.fare,
        money.commission,
        money.driverEarn,
        payment_method || 'cash'
      ]
    );

    const trip = rows[0];
    await pool.query('INSERT INTO trip_events (trip_id, event_type, payload) VALUES ($1,$2,$3)', [trip.id, 'TRIP_CREATED', { pickup, drop }]);

    // Find nearby drivers and emit offers
    const radiusKm = Number(process.env.DRIVER_SEARCH_RADIUS_KM || 2);
    const d = await pool.query(
      'SELECT id, last_lat, last_lng FROM drivers WHERE is_online=true AND is_approved=true AND last_lat IS NOT NULL AND last_lng IS NOT NULL'
    );

    const candidates = d.rows
      .map((dr) => ({
        id: dr.id,
        dist: haversineKm(pickup.lat, pickup.lng, dr.last_lat, dr.last_lng)
      }))
      .filter((x) => x.dist <= radiusKm)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 10);

    candidates.forEach((c) => {
      io.to(`driver:${c.id}`).emit('trip_offer', {
        trip_id: trip.id,
        pickup,
        drop,
        fare: trip.fare,
        distance_km: trip.distance_km,
        near_km: Number(c.dist.toFixed(2))
      });
    });

    io.to(`passenger:${req.user.id}`).emit('trip_update', { trip_id: trip.id, status: 'SEARCHING' });

    res.json({ trip, offered_to: candidates.map((x) => x.id) });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Driver accept trip
app.post('/api/trips/:id/accept', authMiddleware('driver'), async (req, res) => {
  const tripId = Number(req.params.id);
  try {
    const { rows } = await pool.query('SELECT * FROM trips WHERE id=$1', [tripId]);
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'Not found' });

    const dr = await pool.query('SELECT is_approved FROM drivers WHERE id=$1', [req.user.id]);
    if (!dr.rows[0]?.is_approved) return res.status(403).json({ error: 'Driver not approved yet' });

    const claimed = await pool.query(
      `UPDATE trips SET driver_id=$1, status='DRIVER_ASSIGNED', updated_at=NOW()
       WHERE id=$2 AND status='SEARCHING'
       RETURNING id, passenger_id, driver_id, status, fare, distance_km`,
      [req.user.id, tripId]
    );

    if (!claimed.rows[0]) return res.status(409).json({ error: 'Already taken or not available' });

    await pool.query('INSERT INTO trip_events (trip_id, event_type, payload) VALUES ($1,$2,$3)', [tripId, 'DRIVER_ASSIGNED', { driver_id: req.user.id }]);

    io.to(`driver:${req.user.id}`).emit('trip_update', { trip_id: tripId, status: 'DRIVER_ASSIGNED' });
    io.to(`passenger:${claimed.rows[0].passenger_id}`).emit('trip_update', { trip_id: tripId, status: 'DRIVER_ASSIGNED', driver_id: req.user.id });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Trip status changes (driver)
app.post('/api/trips/:id/status', authMiddleware('driver'), async (req, res) => {
  const tripId = Number(req.params.id);
  const { status } = req.body;
  const allowed = new Set(['ARRIVED', 'STARTED', 'COMPLETED', 'CANCELLED']);
  if (!allowed.has(status)) return res.status(400).json({ error: 'Bad status' });

  try {
    const { rows } = await pool.query('SELECT * FROM trips WHERE id=$1', [tripId]);
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.driver_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    await pool.query('UPDATE trips SET status=$1, updated_at=NOW() WHERE id=$2', [status, tripId]);
    await pool.query('INSERT INTO trip_events (trip_id, event_type, payload) VALUES ($1,$2,$3)', [tripId, status, {}]);

    if (status === 'COMPLETED') {
      await pool.query('UPDATE drivers SET total_earn = total_earn + $1 WHERE id=$2', [Number(t.driver_earn || 0), req.user.id]);
    }

    io.to(`driver:${req.user.id}`).emit('trip_update', { trip_id: tripId, status });
    io.to(`passenger:${t.passenger_id}`).emit('trip_update', { trip_id: tripId, status });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Passenger cancel
app.post('/api/trips/:id/cancel', authMiddleware('passenger'), async (req, res) => {
  const tripId = Number(req.params.id);
  try {
    const { rows } = await pool.query('SELECT * FROM trips WHERE id=$1', [tripId]);
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.passenger_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    await pool.query("UPDATE trips SET status='CANCELLED', updated_at=NOW() WHERE id=$1 AND status NOT IN ('COMPLETED')", [tripId]);
    await pool.query('INSERT INTO trip_events (trip_id, event_type, payload) VALUES ($1,$2,$3)', [tripId, 'CANCELLED', {}]);

    if (t.driver_id) io.to(`driver:${t.driver_id}`).emit('trip_update', { trip_id: tripId, status: 'CANCELLED' });
    io.to(`passenger:${req.user.id}`).emit('trip_update', { trip_id: tripId, status: 'CANCELLED' });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Read trip
app.get('/api/trips/:id', authMiddleware(), async (req, res) => {
  const tripId = Number(req.params.id);
  try {
    const { rows } = await pool.query('SELECT * FROM trips WHERE id=$1', [tripId]);
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'Not found' });

    if (req.user.role === 'passenger' && t.passenger_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (req.user.role === 'driver' && t.driver_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    let driver = null;
    if (t.driver_id) {
      const d = await pool.query(
        `SELECT d.id, d.first_name, d.last_name, d.rating, c.brand, c.model, c.plate_number
         FROM drivers d
         LEFT JOIN cars c ON c.driver_id=d.id
         WHERE d.id=$1`,
        [t.driver_id]
      );
      driver = d.rows[0] || null;
    }

    res.json({ trip: t, driver });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Pricing
app.get('/api/pricing', async (req, res) => {
  const p = await getPricing();
  res.json(p);
});

// Admin auth (simple header)
function adminAuth(req, res, next) {
  const u = req.headers['x-admin-user'];
  const p = req.headers['x-admin-pass'];
  if (u === process.env.ADMIN_WEB_USER && p === process.env.ADMIN_WEB_PASS) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/admin/overview', adminAuth, async (req, res) => {
  const drivers = await pool.query('SELECT COUNT(*)::int AS c, SUM(CASE WHEN is_approved THEN 1 ELSE 0 END)::int AS approved FROM drivers');
  const trips = await pool.query("SELECT COUNT(*)::int AS c, SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END)::int AS completed FROM trips");
  const pricing = await getPricing();
  res.json({ drivers: drivers.rows[0], trips: trips.rows[0], pricing });
});

app.get('/api/admin/drivers', adminAuth, async (req, res) => {
  const q = await pool.query(
    `SELECT d.*, c.brand, c.model, c.year, c.plate_number
     FROM drivers d
     LEFT JOIN cars c ON c.driver_id=d.id
     ORDER BY d.created_at DESC
     LIMIT 200`
  );
  res.json({ drivers: q.rows });
});

app.post('/api/admin/driver/:id/approve', adminAuth, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('UPDATE drivers SET is_approved=true WHERE id=$1', [id]);
  await pool.query('INSERT INTO admin_audit_logs (admin_user, action, payload) VALUES ($1,$2,$3)', [process.env.ADMIN_WEB_USER, 'APPROVE_DRIVER', { driver_id: id }]);
  io.to(`driver:${id}`).emit('admin_update', { is_approved: true });
  res.json({ ok: true });
});

app.post('/api/admin/driver/:id/reject', adminAuth, async (req, res) => {
  const id = Number(req.params.id);
  // User request: "Reject" should fully remove the driver from the database.
  // trips.driver_id is ON DELETE SET NULL; cars/documents are ON DELETE CASCADE.
  await pool.query('DELETE FROM drivers WHERE id=$1', [id]);
  await pool.query('INSERT INTO admin_audit_logs (admin_user, action, payload) VALUES ($1,$2,$3)', [process.env.ADMIN_WEB_USER, 'REJECT_DRIVER_DELETE', { driver_id: id }]);
  io.to(`driver:${id}`).emit('admin_update', { deleted: true });
  res.json({ ok: true, deleted: true });
});

// Explicit "Tam sil" action (hard delete) – kept as separate button in UI
app.post('/api/admin/driver/:id/delete', adminAuth, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM drivers WHERE id=$1', [id]);
  await pool.query('INSERT INTO admin_audit_logs (admin_user, action, payload) VALUES ($1,$2,$3)', [process.env.ADMIN_WEB_USER, 'DELETE_DRIVER', { driver_id: id }]);
  io.to(`driver:${id}`).emit('admin_update', { deleted: true });
  res.json({ ok: true, deleted: true });
});

app.get('/api/admin/trips', adminAuth, async (req, res) => {
  const q = await pool.query(
    `SELECT t.*, p.first_name AS p_first, p.last_name AS p_last, d.first_name AS d_first, d.last_name AS d_last
     FROM trips t
     JOIN passengers p ON p.id=t.passenger_id
     LEFT JOIN drivers d ON d.id=t.driver_id
     ORDER BY t.created_at DESC
     LIMIT 300`
  );
  res.json({ trips: q.rows });
});

app.post('/api/admin/pricing', adminAuth, async (req, res) => {
  const { baseFare, includedKm, perKm, commissionRate } = req.body;
  await pool.query(
    'UPDATE pricing_settings SET base_fare=$1, included_km=$2, per_km=$3, commission_rate=$4, updated_at=NOW() WHERE id=1',
    [Number(baseFare), Number(includedKm), Number(perKm), Number(commissionRate)]
  );
  await pool.query('INSERT INTO admin_audit_logs (admin_user, action, payload) VALUES ($1,$2,$3)', [process.env.ADMIN_WEB_USER, 'UPDATE_PRICING', { baseFare, includedKm, perKm, commissionRate }]);
  res.json({ ok: true });
});

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is missing');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is missing');
    process.exit(1);
  }

  await initDb();

  const baseUrl = process.env.APP_BASE_URL || '';
  const bots = setupBots(app, { baseUrl });
  try {
    await bots.setWebhooks();
  } catch (e) {
    console.warn('Webhook setup skipped/failed:', e.message);
  }

  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log('PayTaksi server listening on', port));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
