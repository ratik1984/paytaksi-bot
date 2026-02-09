import express from 'express';
import multer from 'multer';

const upload = multer({ dest: 'uploads/' });
export const apiRouter = express.Router();

function isAdmin(req) {
  const admins = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return admins.includes(String(req.user.tg_id));
}

async function upsertUser(db, tg) {
  const q = await db.query(
    `INSERT INTO users (tg_id, role, first_name, last_name, username)
     VALUES ($1, 'rider', $2, $3, $4)
     ON CONFLICT (tg_id) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, username=EXCLUDED.username
     RETURNING *`,
    [tg.tg_id, tg.first_name || null, tg.last_name || null, tg.username || null]
  );
  return q.rows[0];
}

// Current user profile + role
apiRouter.get('/me', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  // if admin, force role admin for UI convenience
  const role = isAdmin(req) ? 'admin' : me.role;
  res.json({ ok: true, me: { ...me, role } });
});

// Driver registration (required docs)
apiRouter.post('/driver/register', upload.fields([
  { name: 'car_reg_front', maxCount: 1 },
  { name: 'car_reg_back', maxCount: 1 },
  { name: 'id_front', maxCount: 1 },
  { name: 'id_back', maxCount: 1 },
  { name: 'license_front', maxCount: 1 },
  { name: 'license_back', maxCount: 1 },
]), async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);

  const body = req.body || {};
  const requiredText = ['phone', 'car_brand', 'car_model', 'car_color', 'car_plate', 'car_year'];
  for (const k of requiredText) {
    if (!body[k]) return res.status(400).json({ ok: false, error: `missing_${k}` });
  }

  const requiredFiles = ['car_reg_front','car_reg_back','id_front','id_back','license_front','license_back'];
  for (const k of requiredFiles) {
    if (!req.files?.[k]?.[0]?.filename) return res.status(400).json({ ok: false, error: `missing_file_${k}` });
  }

  // update user phone + role
  await db.query('UPDATE users SET phone=$1, role=$2 WHERE id=$3', [body.phone, 'driver', me.id]);

  const docs = {};
  for (const k of requiredFiles) docs[k] = `/uploads/${req.files[k][0].filename}`;

  await db.query(
    `INSERT INTO driver_profiles (user_id, status, car_brand, car_model, car_color, car_plate, car_year, docs)
     VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET status='pending', car_brand=EXCLUDED.car_brand, car_model=EXCLUDED.car_model,
           car_color=EXCLUDED.car_color, car_plate=EXCLUDED.car_plate, car_year=EXCLUDED.car_year,
           docs=EXCLUDED.docs, reviewed_by=NULL, reviewed_at=NULL, review_note=NULL`,
    [me.id, body.car_brand, body.car_model, body.car_color, body.car_plate, Number(body.car_year), JSON.stringify(docs)]
  );

  res.json({ ok: true });
});

apiRouter.get('/driver/profile', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const prof = await db.query('SELECT * FROM driver_profiles WHERE user_id=$1', [me.id]);
  res.json({ ok: true, profile: prof.rows[0] || null });
});

apiRouter.post('/driver/online', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const prof = await db.query('SELECT status FROM driver_profiles WHERE user_id=$1', [me.id]);
  if (!prof.rows[0] || prof.rows[0].status !== 'approved') return res.status(403).json({ ok: false, error: 'driver_not_approved' });
  await db.query('UPDATE users SET role=$1 WHERE id=$2', ['driver', me.id]);
  res.json({ ok: true });
});

// Location updates
apiRouter.post('/location', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const { lat, lng, heading, speed } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ ok: false, error: 'bad_coords' });

  await db.query(
    `INSERT INTO locations (user_id, lat, lng, heading, speed, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET lat=$2, lng=$3, heading=$4, speed=$5, updated_at=now()`,
    [me.id, lat, lng, heading ?? null, speed ?? null]
  );

  // notify sockets
  req.app.locals.io?.to(`user:${me.id}`).emit('location:update', { user_id: me.id, lat, lng, heading, speed, updated_at: Date.now() });
  res.json({ ok: true });
});

// Rider creates ride
apiRouter.post('/rides', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const b = req.body || {};
  const required = ['pickup_lat','pickup_lng','pickup_address','drop_lat','drop_lng','drop_address','payment_method'];
  for (const k of required) if (b[k] === undefined || b[k] === null || b[k] === '') return res.status(400).json({ ok: false, error: `missing_${k}` });

  const rideQ = await db.query(
    `INSERT INTO rides (rider_id, pickup_lat, pickup_lng, pickup_address, drop_lat, drop_lng, drop_address, payment_method, fare_est)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [me.id, b.pickup_lat, b.pickup_lng, b.pickup_address, b.drop_lat, b.drop_lng, b.drop_address, b.payment_method, Number(b.fare_est || 0)]
  );
  const ride = rideQ.rows[0];

  await db.query(`INSERT INTO ride_events (ride_id, actor_user_id, type, payload) VALUES ($1,$2,'created',$3::jsonb)`,
    [ride.id, me.id, JSON.stringify({})]);

  // assign to nearest approved driver (simple: most recently updated)
  const driverQ = await db.query(
    `SELECT u.id as user_id, l.lat, l.lng
     FROM users u
     JOIN driver_profiles dp ON dp.user_id=u.id AND dp.status='approved'
     LEFT JOIN locations l ON l.user_id=u.id
     ORDER BY l.updated_at DESC NULLS LAST
     LIMIT 1`
  );
  if (driverQ.rows[0]) {
    const driverId = driverQ.rows[0].user_id;
    await db.query(`UPDATE rides SET driver_id=$1, status='assigned', updated_at=now() WHERE id=$2`, [driverId, ride.id]);
    await db.query(`INSERT INTO ride_events (ride_id, actor_user_id, type, payload) VALUES ($1,NULL,'assigned',$2::jsonb)`,
      [ride.id, JSON.stringify({ driver_id: driverId })]);

    req.app.locals.io?.to(`user:${driverId}`).emit('ride:incoming', { ride_id: ride.id });
    req.app.locals.io?.to(`user:${me.id}`).emit('ride:update', { ride_id: ride.id });
  }

  res.json({ ok: true, ride_id: ride.id });
});

apiRouter.get('/rides/my', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const q = await db.query(
    `SELECT * FROM rides WHERE rider_id=$1 OR driver_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [me.id]
  );
  res.json({ ok: true, rides: q.rows });
});

apiRouter.get('/rides/:id', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const id = Number(req.params.id);
  const q = await db.query('SELECT * FROM rides WHERE id=$1', [id]);
  const ride = q.rows[0];
  if (!ride) return res.status(404).json({ ok: false, error: 'not_found' });
  if (ride.rider_id !== me.id && ride.driver_id !== me.id && !isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

  const ev = await db.query('SELECT * FROM ride_events WHERE ride_id=$1 ORDER BY created_at ASC', [id]);
  res.json({ ok: true, ride, events: ev.rows });
});

// Driver actions: accept / decline / start / complete
apiRouter.post('/rides/:id/accept', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const id = Number(req.params.id);
  const q = await db.query('SELECT * FROM rides WHERE id=$1', [id]);
  const ride = q.rows[0];
  if (!ride) return res.status(404).json({ ok: false, error: 'not_found' });
  if (ride.driver_id !== me.id) return res.status(403).json({ ok: false, error: 'not_your_ride' });

  await db.query(`UPDATE rides SET status='accepted', updated_at=now() WHERE id=$1`, [id]);
  await db.query(`INSERT INTO ride_events (ride_id, actor_user_id, type, payload) VALUES ($1,$2,'accepted',$3::jsonb)`, [id, me.id, JSON.stringify({})]);

  req.app.locals.io?.to(`user:${ride.rider_id}`).emit('ride:update', { ride_id: id });
  req.app.locals.io?.to(`user:${me.id}`).emit('ride:update', { ride_id: id });
  res.json({ ok: true });
});

apiRouter.post('/rides/:id/decline', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const id = Number(req.params.id);
  const q = await db.query('SELECT * FROM rides WHERE id=$1', [id]);
  const ride = q.rows[0];
  if (!ride) return res.status(404).json({ ok: false, error: 'not_found' });
  if (ride.driver_id !== me.id) return res.status(403).json({ ok: false, error: 'not_your_ride' });

  await db.query(`UPDATE rides SET driver_id=NULL, status='searching', updated_at=now() WHERE id=$1`, [id]);
  await db.query(`INSERT INTO ride_events (ride_id, actor_user_id, type, payload) VALUES ($1,$2,'declined',$3::jsonb)`, [id, me.id, JSON.stringify({})]);

  req.app.locals.io?.to(`user:${ride.rider_id}`).emit('ride:update', { ride_id: id });
  res.json({ ok: true });
});

apiRouter.post('/rides/:id/start', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const id = Number(req.params.id);
  const q = await db.query('SELECT * FROM rides WHERE id=$1', [id]);
  const ride = q.rows[0];
  if (!ride) return res.status(404).json({ ok: false, error: 'not_found' });
  if (ride.driver_id !== me.id) return res.status(403).json({ ok: false, error: 'not_your_ride' });

  await db.query(`UPDATE rides SET status='in_trip', updated_at=now() WHERE id=$1`, [id]);
  await db.query(`INSERT INTO ride_events (ride_id, actor_user_id, type, payload) VALUES ($1,$2,'trip_started',$3::jsonb)`, [id, me.id, JSON.stringify({})]);

  req.app.locals.io?.to(`user:${ride.rider_id}`).emit('ride:update', { ride_id: id });
  req.app.locals.io?.to(`user:${me.id}`).emit('ride:update', { ride_id: id });
  res.json({ ok: true });
});

apiRouter.post('/rides/:id/complete', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const id = Number(req.params.id);
  const q = await db.query('SELECT * FROM rides WHERE id=$1', [id]);
  const ride = q.rows[0];
  if (!ride) return res.status(404).json({ ok: false, error: 'not_found' });
  if (ride.driver_id !== me.id && !isAdmin(req)) return res.status(403).json({ ok: false, error: 'not_allowed' });

  await db.query(`UPDATE rides SET status='completed', updated_at=now() WHERE id=$1`, [id]);
  await db.query(`INSERT INTO ride_events (ride_id, actor_user_id, type, payload) VALUES ($1,$2,'completed',$3::jsonb)`, [id, me.id, JSON.stringify({})]);

  req.app.locals.io?.to(`user:${ride.rider_id}`).emit('ride:update', { ride_id: id });
  req.app.locals.io?.to(`user:${ride.driver_id}`).emit('ride:update', { ride_id: id });
  res.json({ ok: true });
});

// Rating (rider rates driver)
apiRouter.post('/rides/:id/rate', async (req, res) => {
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const id = Number(req.params.id);
  const { stars } = req.body || {};
  const s = Math.max(1, Math.min(5, Number(stars || 0)));
  const q = await db.query('SELECT * FROM rides WHERE id=$1', [id]);
  const ride = q.rows[0];
  if (!ride) return res.status(404).json({ ok: false, error: 'not_found' });
  if (ride.rider_id !== me.id) return res.status(403).json({ ok: false, error: 'not_your_ride' });
  if (!ride.driver_id) return res.status(400).json({ ok: false, error: 'no_driver' });

  await db.query(`INSERT INTO ride_events (ride_id, actor_user_id, type, payload) VALUES ($1,$2,'rated',$3::jsonb)`,
    [id, me.id, JSON.stringify({ stars: s, driver_id: ride.driver_id })]);

  const u = await db.query('SELECT rating_avg, rating_count FROM users WHERE id=$1', [ride.driver_id]);
  const { rating_avg, rating_count } = u.rows[0];
  const newCount = rating_count + 1;
  const newAvg = (rating_avg * rating_count + s) / newCount;
  await db.query('UPDATE users SET rating_avg=$1, rating_count=$2 WHERE id=$3', [newAvg, newCount, ride.driver_id]);

  res.json({ ok: true, rating_avg: newAvg, rating_count: newCount });
});

// Admin endpoints
apiRouter.get('/admin/summary', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_only' });
  const db = req.app.locals.db;
  const users = await db.query('SELECT count(*)::int as c FROM users');
  const rides = await db.query('SELECT count(*)::int as c FROM rides');
  const pending = await db.query("SELECT count(*)::int as c FROM driver_profiles WHERE status='pending'");
  res.json({ ok: true, users: users.rows[0].c, rides: rides.rows[0].c, pending_drivers: pending.rows[0].c });
});

apiRouter.get('/admin/drivers', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_only' });
  const db = req.app.locals.db;
  const q = await db.query(
    `SELECT dp.*, u.tg_id, u.first_name, u.last_name, u.username, u.phone, u.rating_avg, u.rating_count
     FROM driver_profiles dp
     JOIN users u ON u.id=dp.user_id
     ORDER BY dp.created_at DESC`
  );
  res.json({ ok: true, drivers: q.rows });
});

apiRouter.post('/admin/drivers/:userId/approve', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_only' });
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const userId = Number(req.params.userId);
  await db.query(
    `UPDATE driver_profiles SET status='approved', reviewed_by=$1, reviewed_at=now(), review_note=NULL WHERE user_id=$2`,
    [me.id, userId]
  );
  res.json({ ok: true });
});

apiRouter.post('/admin/drivers/:userId/reject', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_only' });
  const db = req.app.locals.db;
  const me = await upsertUser(db, req.user);
  const userId = Number(req.params.userId);
  const note = (req.body?.note || '').toString().slice(0, 300);
  await db.query(
    `UPDATE driver_profiles SET status='rejected', reviewed_by=$1, reviewed_at=now(), review_note=$3 WHERE user_id=$2`,
    [me.id, userId, note || 'Rejected']
  );
  res.json({ ok: true });
});

apiRouter.get('/admin/rides', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_only' });
  const db = req.app.locals.db;
  const q = await db.query(
    `SELECT r.*,
      ru.tg_id as rider_tg_id, ru.first_name as rider_first_name, ru.last_name as rider_last_name, ru.username as rider_username,
      du.tg_id as driver_tg_id, du.first_name as driver_first_name, du.last_name as driver_last_name, du.username as driver_username
     FROM rides r
     JOIN users ru ON ru.id=r.rider_id
     LEFT JOIN users du ON du.id=r.driver_id
     ORDER BY r.created_at DESC
     LIMIT 200`
  );
  res.json({ ok: true, rides: q.rows });
});
