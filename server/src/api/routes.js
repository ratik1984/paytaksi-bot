const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { osrmRoute, haversineKm } = require('../geo');
const { calcFare } = require('../pricing');
const { getSetting } = require('../db');

function mustUnsafe(req) {
  if (String(process.env.ALLOW_TG_UNSAFE || '') === '1') return;
  throw new Error('Telegram initData validation not implemented; set ALLOW_TG_UNSAFE=1 for MVP');
}

async function ensureUser(pool, { telegramId, role, firstName, lastName, phone }) {
  const existing = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [telegramId]);
  if (existing.rows[0]) return existing.rows[0];
  const ins = await pool.query(
    'INSERT INTO users(telegram_id, role, first_name, last_name, phone_e164) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [telegramId, role, firstName || null, lastName || null, phone || null]
  );
  return ins.rows[0];
}

async function getPricing(pool) {
  const baseFare = Number(await getSetting(pool, 'base_fare'));
  const includedKm = Number(await getSetting(pool, 'included_km'));
  const perKm = Number(await getSetting(pool, 'per_km'));
  const commissionPct = Number(await getSetting(pool, 'commission_pct'));
  return { baseFare, includedKm, perKm, commissionPct };
}

function registerApi(app, { pool, io, bots }) {
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/settings', async (req, res) => {
    const pricing = await getPricing(pool);
    res.json({ pricing });
  });

  app.post('/api/quote', async (req, res) => {
    mustUnsafe(req);
    const schema = z.object({ pickup: z.object({ lat: z.number(), lng: z.number() }), dropoff: z.object({ lat: z.number(), lng: z.number() }) });
    const body = schema.parse(req.body);

    const { distanceKm, durationMin } = await osrmRoute({
      pickupLat: body.pickup.lat,
      pickupLng: body.pickup.lng,
      dropLat: body.dropoff.lat,
      dropLng: body.dropoff.lng
    });

    const pricing = await getPricing(pool);
    // MVP surge = 1.0
    const fare = calcFare({
      distanceKm,
      baseFare: pricing.baseFare,
      includedKm: pricing.includedKm,
      perKm: pricing.perKm,
      surgeMultiplier: 1.0,
      commissionPct: pricing.commissionPct
    });

    res.json({
      distance_km: fare.distance_km,
      duration_min: Math.round(durationMin),
      fare
    });
  });

  app.post('/api/rides', async (req, res) => {
    mustUnsafe(req);
    const schema = z.object({
      passenger_tg_id: z.number(),
      passenger: z.object({ first_name: z.string().optional(), last_name: z.string().optional(), phone: z.string().optional() }).optional(),
      pickup: z.object({ lat: z.number(), lng: z.number(), text: z.string().optional() }),
      dropoff: z.object({ lat: z.number(), lng: z.number(), text: z.string().optional() })
    });
    const body = schema.parse(req.body);

    const passenger = await ensureUser(pool, {
      telegramId: body.passenger_tg_id,
      role: 'passenger',
      firstName: body.passenger?.first_name,
      lastName: body.passenger?.last_name,
      phone: body.passenger?.phone
    });

    const { distanceKm, durationMin } = await osrmRoute({
      pickupLat: body.pickup.lat,
      pickupLng: body.pickup.lng,
      dropLat: body.dropoff.lat,
      dropLng: body.dropoff.lng
    });

    const pricing = await getPricing(pool);
    const fare = calcFare({
      distanceKm,
      baseFare: pricing.baseFare,
      includedKm: pricing.includedKm,
      perKm: pricing.perKm,
      surgeMultiplier: 1.0,
      commissionPct: pricing.commissionPct
    });

    const rideId = uuidv4();
    await pool.query(
      `INSERT INTO rides(id, passenger_user_id, status,
        pickup_lat,pickup_lng,pickup_text,
        dropoff_lat,dropoff_lng,dropoff_text,
        distance_km,duration_min,
        base_fare,included_km,per_km,surge_multiplier,total_fare,commission_pct,commission_amount,driver_earnings
      ) VALUES($1,$2,'requested',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        rideId,
        passenger.id,
        body.pickup.lat, body.pickup.lng, body.pickup.text || null,
        body.dropoff.lat, body.dropoff.lng, body.dropoff.text || null,
        fare.distance_km,
        Math.round(durationMin),
        fare.base_fare,
        fare.included_km,
        fare.per_km,
        fare.surge_multiplier,
        fare.total_fare,
        fare.commission_pct,
        fare.commission_amount,
        fare.driver_earnings
      ]
    );

    // Dispatch
    const radiusKm = Number(await getSetting(pool, 'dispatch_radius_km')) || 2;
    const timeoutSec = Number(await getSetting(pool, 'dispatch_offer_timeout_sec')) || 15;

    const nearby = await pool.query(
      `SELECT u.id as user_id, u.telegram_id, dl.lat, dl.lng
       FROM driver_locations dl
       JOIN users u ON u.id = dl.driver_user_id
       JOIN drivers d ON d.user_id = u.id
       WHERE dl.is_online=true AND d.status='approved' AND dl.updated_at > NOW() - INTERVAL '30 seconds'`
    );

    const candidates = nearby.rows
      .map((r) => ({
        user_id: r.user_id,
        telegram_id: Number(r.telegram_id),
        dist_km: haversineKm(body.pickup.lat, body.pickup.lng, Number(r.lat), Number(r.lng))
      }))
      .filter((x) => x.dist_km <= radiusKm)
      .sort((a, b) => a.dist_km - b.dist_km)
      .slice(0, 10);

    if (candidates.length === 0) {
      io.to(`passenger:${body.passenger_tg_id}`).emit('ride_update', { ride_id: rideId, status: 'requested', note: 'no_drivers' });
      return res.json({ ok: true, ride_id: rideId, dispatched: 0 });
    }

    // Offer sequentially (simple MVP)
    let offered = 0;
    for (const c of candidates) {
      await pool.query('UPDATE rides SET status=$2 WHERE id=$1', [rideId, 'offered']);
      await pool.query(
        `INSERT INTO ride_offers(ride_id, driver_user_id, status) VALUES($1,$2,'offered')
         ON CONFLICT (ride_id, driver_user_id) DO NOTHING`,
        [rideId, c.user_id]
      );

      offered++;
      // Notify driver (socket + telegram)
      io.to(`driver:${c.telegram_id}`).emit('ride_offer', {
        ride_id: rideId,
        pickup: body.pickup,
        dropoff: body.dropoff,
        fare
      });

      try {
        await bots.driver.telegram.sendMessage(c.telegram_id, `🚕 Yeni sifariş\n\n📍 ${body.pickup.text || 'Pickup'}\n🏁 ${body.dropoff.text || 'Dropoff'}\n💰 ${fare.total_fare} AZN`, {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Qəbul et', callback_data: `accept:${rideId}` },
              { text: '✖️ Rədd et', callback_data: `reject:${rideId}` }
            ],[
              { text: 'Paneli aç', web_app: { url: `${process.env.APP_BASE_URL}/d/?tg_id=${c.telegram_id}` } }
            ]]
          }
        });
      } catch (e) {
        // ignore
      }

      // wait timeout for accept
      const accepted = await waitForAccept(pool, rideId, timeoutSec);
      if (accepted) break;
      // expire this offer
      await pool.query(
        `UPDATE ride_offers SET status='expired', responded_at=NOW() WHERE ride_id=$1 AND driver_user_id=$2 AND status='offered'`,
        [rideId, c.user_id]
      );
    }

    res.json({ ok: true, ride_id: rideId, dispatched: offered });
  });

  app.post('/api/driver/online', async (req, res) => {
    mustUnsafe(req);
    const schema = z.object({ driver_tg_id: z.number(), is_online: z.boolean() });
    const body = schema.parse(req.body);

    const u = await ensureUser(pool, { telegramId: body.driver_tg_id, role: 'driver' });
    await pool.query(
      `INSERT INTO driver_locations(driver_user_id, lat, lng, is_online) VALUES($1,0,0,$2)
       ON CONFLICT (driver_user_id) DO UPDATE SET is_online=EXCLUDED.is_online, updated_at=NOW()`,
      [u.id, body.is_online]
    );
    res.json({ ok: true });
  });

  app.post('/api/driver/location', async (req, res) => {
    mustUnsafe(req);
    const schema = z.object({ driver_tg_id: z.number(), lat: z.number(), lng: z.number(), heading: z.number().optional(), speed: z.number().optional() });
    const body = schema.parse(req.body);

    const u = await ensureUser(pool, { telegramId: body.driver_tg_id, role: 'driver' });
    await pool.query(
      `INSERT INTO driver_locations(driver_user_id, lat, lng, heading, speed, is_online)
       VALUES($1,$2,$3,$4,$5,TRUE)
       ON CONFLICT (driver_user_id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, heading=EXCLUDED.heading, speed=EXCLUDED.speed, is_online=TRUE, updated_at=NOW()`,
      [u.id, body.lat, body.lng, body.heading || null, body.speed || null]
    );

    io.emit('driver_location', { driver_tg_id: body.driver_tg_id, lat: body.lat, lng: body.lng });
    res.json({ ok: true });
  });

  app.get('/api/admin/pending_drivers', async (req, res) => {
    mustUnsafe(req);
    const tgId = Number(req.query.tg_id || 0);
    if (!tgId) return res.status(400).json({ error: 'tg_id required' });
    if (String(tgId) !== String(process.env.SUPER_ADMIN_ID)) return res.status(403).json({ error: 'forbidden' });

    const r = await pool.query(
      `SELECT u.telegram_id, u.first_name, u.last_name, u.phone_e164, d.*
       FROM drivers d
       JOIN users u ON u.id=d.user_id
       WHERE d.status='pending'
       ORDER BY d.created_at ASC`
    );
    res.json({ items: r.rows });
  });

  app.post('/api/admin/approve_driver', async (req, res) => {
    mustUnsafe(req);
    const schema = z.object({ admin_tg_id: z.number(), driver_tg_id: z.number(), approve: z.boolean() });
    const body = schema.parse(req.body);
    if (String(body.admin_tg_id) !== String(process.env.SUPER_ADMIN_ID)) return res.status(403).json({ error: 'forbidden' });

    const u = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [body.driver_tg_id]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({ error: 'driver not found' });

    await pool.query(
      `UPDATE drivers SET status=$2, approved_at=CASE WHEN $2='approved' THEN NOW() ELSE NULL END WHERE user_id=$1`,
      [user.id, body.approve ? 'approved' : 'rejected']
    );

    try {
      await bots.driver.telegram.sendMessage(body.driver_tg_id, body.approve ? '✅ Sən təsdiqləndin! İndi online ola bilərsən.' : '❌ Sürücü müraciətin rədd edildi.');
    } catch (e) {}

    res.json({ ok: true });
  });

  app.post('/api/admin/pricing', async (req, res) => {
    mustUnsafe(req);
    const schema = z.object({ admin_tg_id: z.number(), base_fare: z.number(), included_km: z.number(), per_km: z.number(), commission_pct: z.number() });
    const body = schema.parse(req.body);
    if (String(body.admin_tg_id) !== String(process.env.SUPER_ADMIN_ID)) return res.status(403).json({ error: 'forbidden' });

    await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', ['base_fare', String(body.base_fare)]);
    await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', ['included_km', String(body.included_km)]);
    await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', ['per_km', String(body.per_km)]);
    await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', ['commission_pct', String(body.commission_pct)]);

    res.json({ ok: true });
  });

    app.post('/api/ride/:id/driver_action', async (req, res) => {
    mustUnsafe(req);
    const schema = z.object({ driver_tg_id: z.number(), action: z.enum(['accept','reject','arrive','start','end']) });
    const body = schema.parse(req.body);
    const id = req.params.id;

    const du = await pool.query("SELECT u.id, d.status FROM users u JOIN drivers d ON d.user_id=u.id WHERE u.telegram_id=", [body.driver_tg_id]);
    const driverRow = du.rows[0];
    if (!driverRow || driverRow.status !== 'approved') return res.status(403).json({ error: 'driver_not_approved' });

    const r = await pool.query("SELECT * FROM rides WHERE id=", [id]);
    const ride = r.rows[0];
    if (!ride) return res.status(404).json({ error: 'not_found' });

    if (body.action === 'accept') {
      if (ride.status === 'accepted' && ride.driver_user_id && Number(ride.driver_user_id) !== Number(driverRow.id)) return res.status(409).json({ error: 'already_taken' });
      await pool.query("UPDATE rides SET status='accepted', driver_user_id=, accepted_at=NOW() WHERE id=", [id, driverRow.id]);
      io.to(`ride:`).emit('ride_update', { ride_id: id, status: 'accepted' });
      return res.json({ ok: true });
    }
    if (body.action === 'reject') {
      await pool.query("UPDATE ride_offers SET status='rejected', responded_at=NOW() WHERE ride_id= AND driver_user_id=", [id, driverRow.id]);
      return res.json({ ok: true });
    }
    if (body.action === 'arrive') {
      await pool.query("UPDATE rides SET status='arrived', arrived_at=NOW() WHERE id= AND driver_user_id=", [id, driverRow.id]);
      io.to(`ride:`).emit('ride_update', { ride_id: id, status: 'arrived' });
      return res.json({ ok: true });
    }
    if (body.action === 'start') {
      await pool.query("UPDATE rides SET status='started', started_at=NOW() WHERE id= AND driver_user_id=", [id, driverRow.id]);
      io.to(`ride:`).emit('ride_update', { ride_id: id, status: 'started' });
      return res.json({ ok: true });
    }
    if (body.action === 'end') {
      await pool.query("UPDATE rides SET status='completed', completed_at=NOW() WHERE id= AND driver_user_id=", [id, driverRow.id]);
      io.to(`ride:`).emit('ride_update', { ride_id: id, status: 'completed' });
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  });

  app.get('/api/ride/:id', async (req, res) => {
    const id = req.params.id;
    const r = await pool.query('SELECT * FROM rides WHERE id=$1', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ride: r.rows[0] });
  });
}

async function waitForAccept(pool, rideId, timeoutSec) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const r = await pool.query("SELECT status FROM rides WHERE id=$1", [rideId]);
    const status = r.rows[0]?.status;
    if (status === 'accepted') return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

module.exports = { registerApi };
