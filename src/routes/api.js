import express from 'express';
import { q } from '../db.js';
import { haversineKm, calcPrice } from '../utils.js';

export function apiRouter({ bots }) {
  const r = express.Router();

  // Create ride (passenger)
  r.post('/ride/create', async (req, res) => {
    try {
      const { passenger_tg, from, to } = req.body || {};
      if (!passenger_tg || !from?.title || !to?.title) {
        return res.status(400).json({ ok:false, error:'bad_request' });
      }

      // block new ride if active exists
      const active = await q(
        `SELECT id, status FROM rides
         WHERE passenger_tg=$1 AND status IN ('searching','accepted','in_progress')
         ORDER BY id DESC LIMIT 1`,
        [passenger_tg]
      );
      if (active.rowCount) {
        return res.status(409).json({ ok:false, error:'active_ride_exists', ride_id: active.rows[0].id, status: active.rows[0].status });
      }

      const dist = haversineKm(from.lat, from.lng, to.lat, to.lng);
      const { price, commission } = calcPrice(dist);

      const ins = await q(
        `INSERT INTO rides (passenger_tg, from_title, from_lat, from_lng, to_title, to_lat, to_lng, distance_km, price_azn, commission_azn)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [passenger_tg, from.title, from.lat ?? null, from.lng ?? null, to.title, to.lat ?? null, to.lng ?? null, dist, price, commission]
      );

      // notify drivers (broadcast to all drivers who started bot)
      const drivers = await q(`SELECT tg_id FROM bot_users WHERE role='driver' ORDER BY tg_id DESC LIMIT 2000`, []);
      const ride = ins.rows[0];
      const msg = `🚕 Yeni sifariş #${ride.id}\n${ride.from_title} → ${ride.to_title}\nMəsafə: ${ride.distance_km.toFixed(2)} km\nQiymət: ${ride.price_azn.toFixed(2)} AZN`;
      for (const d of drivers.rows) {
        bots.driver.telegram.sendMessage(d.tg_id, msg).catch(()=>{});
      }

      return res.json({ ok:true, ride });
    } catch (e) {
      console.error('ride/create', e);
      return res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // List passenger rides
  r.get('/ride/list', async (req, res) => {
    const passenger_tg = Number(req.query.passenger_tg);
    if (!passenger_tg) return res.status(400).json({ ok:false, error:'bad_request' });
    const rows = await q(`SELECT * FROM rides WHERE passenger_tg=$1 ORDER BY id DESC LIMIT 20`, [passenger_tg]);
    res.json({ ok:true, items: rows.rows });
  });

  // Driver: list searching rides
  r.get('/ride/searching', async (_req, res) => {
    const rows = await q(`SELECT * FROM rides WHERE status='searching' ORDER BY id DESC LIMIT 20`, []);
    res.json({ ok:true, items: rows.rows });
  });

  // Driver accept
  r.post('/ride/accept', async (req, res) => {
    try {
      const { driver_tg, ride_id } = req.body || {};
      if (!driver_tg || !ride_id) return res.status(400).json({ ok:false, error:'bad_request' });

      const rideRes = await q(`SELECT * FROM rides WHERE id=$1`, [ride_id]);
      if (!rideRes.rowCount) return res.status(404).json({ ok:false, error:'not_found' });
      const ride = rideRes.rows[0];
      if (ride.status !== 'searching') return res.status(409).json({ ok:false, error:'not_available', status: ride.status });

      const upd = await q(
        `UPDATE rides SET driver_tg=$1, status='accepted', updated_at=NOW() WHERE id=$2 AND status='searching' RETURNING *`,
        [driver_tg, ride_id]
      );
      if (!upd.rowCount) return res.status(409).json({ ok:false, error:'not_available' });

      // notify passenger + driver
      const passengerMsg = `✅ Sifariş #${ride_id} sürücü tərəfindən qəbul edildi.\nChat açmaq üçün mini-app-da sifarişə daxil ol.`;
      bots.passenger.telegram.sendMessage(ride.passenger_tg, passengerMsg).catch(()=>{});

      const driverMsg = `✅ Qəbul etdiniz: #${ride_id}.\nSərnişinlə chat üçün mini-app-da sifarişə daxil olun.`;
      bots.driver.telegram.sendMessage(driver_tg, driverMsg).catch(()=>{});

      res.json({ ok:true, ride: upd.rows[0] });
    } catch (e) {
      console.error('ride/accept', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // Passenger cancel
  r.post('/ride/cancel', async (req, res) => {
    try {
      const { passenger_tg, ride_id } = req.body || {};
      if (!passenger_tg || !ride_id) return res.status(400).json({ ok:false, error:'bad_request' });

      const rideRes = await q(`SELECT * FROM rides WHERE id=$1`, [ride_id]);
      if (!rideRes.rowCount) return res.status(404).json({ ok:false, error:'not_found' });
      const ride = rideRes.rows[0];
      if (ride.passenger_tg !== Number(passenger_tg)) return res.status(403).json({ ok:false, error:'forbidden' });
      if (['completed','cancelled'].includes(ride.status)) return res.status(409).json({ ok:false, error:'already_done', status: ride.status });

      const upd = await q(`UPDATE rides SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *`, [ride_id]);

      // notify driver if exists
      if (ride.driver_tg) {
        bots.driver.telegram.sendMessage(ride.driver_tg, `❌ Sifariş #${ride_id} sərnişin tərəfindən ləğv olundu.`).catch(()=>{});
      }
      res.json({ ok:true, ride: upd.rows[0] });
    } catch (e) {
      console.error('ride/cancel', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // Chat send (passenger/driver)
  r.post('/chat/send', async (req, res) => {
    try {
      const { ride_id, sender_role, sender_tg, message } = req.body || {};
      if (!ride_id || !sender_role || !sender_tg || !message) return res.status(400).json({ ok:false, error:'bad_request' });

      const rideRes = await q(`SELECT * FROM rides WHERE id=$1`, [ride_id]);
      if (!rideRes.rowCount) return res.status(404).json({ ok:false, error:'not_found' });
      const ride = rideRes.rows[0];

      const isPassenger = sender_role === 'passenger' && Number(sender_tg) === Number(ride.passenger_tg);
      const isDriver = sender_role === 'driver' && Number(sender_tg) === Number(ride.driver_tg);
      if (!isPassenger && !isDriver) return res.status(403).json({ ok:false, error:'forbidden' });

      const ins = await q(
        `INSERT INTO ride_chat_messages (ride_id, sender_role, sender_tg, message) VALUES ($1,$2,$3,$4) RETURNING *`,
        [ride_id, sender_role, sender_tg, String(message).slice(0,1000)]
      );

      // notify counterpart
      if (isPassenger && ride.driver_tg) {
        bots.driver.telegram.sendMessage(ride.driver_tg, `💬 Mesaj (Sifariş #${ride_id}): ${message}`).catch(()=>{});
      }
      if (isDriver) {
        bots.passenger.telegram.sendMessage(ride.passenger_tg, `💬 Mesaj (Sifariş #${ride_id}): ${message}`).catch(()=>{});
      }

      res.json({ ok:true, item: ins.rows[0] });
    } catch (e) {
      console.error('chat/send', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // Chat list
  r.get('/chat/list', async (req, res) => {
    const ride_id = Number(req.query.ride_id);
    if (!ride_id) return res.status(400).json({ ok:false, error:'bad_request' });
    const rows = await q(`SELECT * FROM ride_chat_messages WHERE ride_id=$1 ORDER BY id ASC LIMIT 200`, [ride_id]);
    res.json({ ok:true, items: rows.rows });
  });

  return r;
}
