import express from 'express';
import bcrypt from 'bcryptjs';
import { q } from './db.js';
import { money2 } from './utils.js';

export function buildAdminRouter() {
  const router = express.Router();

  router.get('/login', (req, res) => {
    res.render('login', { error: null });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const u = process.env.ADMIN_USERNAME || 'admin';
    const hash = process.env.ADMIN_PASSWORD_HASH || '';

    if (username !== u) return res.render('login', { error: 'Login səhvdir' });
    const ok = bcrypt.compareSync(password || '', hash);
    if (!ok) return res.render('login', { error: 'Şifrə səhvdir' });

    req.session.admin = { username };
    res.redirect('/admin');
  });

  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  router.use((req, res, next) => {
    if (!req.session.admin) return res.redirect('/admin/login');
    next();
  });

  router.get('/', async (req, res) => {
    const drivers = await q('SELECT COUNT(*)::int AS n FROM drivers');
    const active = await q("SELECT COUNT(*)::int AS n FROM drivers WHERE status='active'");
    const pending = await q("SELECT COUNT(*)::int AS n FROM drivers WHERE status='pending'");
    const topups = await q("SELECT COUNT(*)::int AS n FROM topup_requests WHERE status='pending'");
    const rides = await q('SELECT COUNT(*)::int AS n FROM rides');
    res.render('dashboard', {
      stats: {
        drivers: drivers.rows[0].n,
        activeDrivers: active.rows[0].n,
        pendingDrivers: pending.rows[0].n,
        pendingTopups: topups.rows[0].n,
        rides: rides.rows[0].n,
      },
    });
  });

  router.get('/drivers', async (req, res) => {
    const list = await q('SELECT * FROM drivers ORDER BY created_at DESC LIMIT 200');
    res.render('drivers', { drivers: list.rows, money2 });
  });

  router.post('/drivers/:id/activate', async (req, res) => {
    const id = Number(req.params.id);
    await q("UPDATE drivers SET status='active' WHERE id=$1", [id]);
    res.redirect('/admin/drivers');
  });

  router.post('/drivers/:id/block', async (req, res) => {
    const id = Number(req.params.id);
    await q("UPDATE drivers SET status='blocked', online=false, busy=false WHERE id=$1", [id]);
    res.redirect('/admin/drivers');
  });

  router.get('/topups', async (req, res) => {
    const list = await q(
      `SELECT t.*, d.first_name, d.last_name, d.phone
       FROM topup_requests t
       JOIN drivers d ON d.id=t.driver_id
       ORDER BY t.created_at DESC
       LIMIT 200`
    );
    res.render('topups', { topups: list.rows, money2 });
  });

  router.post('/topups/:id/approve', async (req, res) => {
    const id = Number(req.params.id);
    const amount = Number(req.body.amount_azn);
    const note = (req.body.note || '').trim();

    const r = await q('SELECT * FROM topup_requests WHERE id=$1', [id]);
    if (!r.rowCount) return res.redirect('/admin/topups');
    const tr = r.rows[0];
    if (tr.status !== 'pending') return res.redirect('/admin/topups');

    await q('UPDATE topup_requests SET status=\'approved\', admin_note=$2, decided_at=NOW() WHERE id=$1', [id, note]);
    await q('UPDATE drivers SET balance = balance + $1 WHERE id=$2', [amount, tr.driver_id]);
    await q(
      "INSERT INTO balance_ledger (driver_id, kind, amount_azn, ref_table, ref_id, note) VALUES ($1,'topup',$2,'topup_requests',$3,$4)",
      [tr.driver_id, amount, id, note || 'Top-up təsdiqləndi']
    );

    res.redirect('/admin/topups');
  });

  router.post('/topups/:id/reject', async (req, res) => {
    const id = Number(req.params.id);
    const note = (req.body.note || '').trim();
    await q('UPDATE topup_requests SET status=\'rejected\', admin_note=$2, decided_at=NOW() WHERE id=$1', [id, note]);
    res.redirect('/admin/topups');
  });

  router.get('/rides', async (req, res) => {
    const list = await q(
      `SELECT r.*, 
              p.first_name AS p_first, p.last_name AS p_last, p.phone AS p_phone,
              d.first_name AS d_first, d.last_name AS d_last, d.phone AS d_phone
       FROM rides r
       LEFT JOIN passengers p ON p.id=r.passenger_id
       LEFT JOIN drivers d ON d.id=r.driver_id
       ORDER BY r.requested_at DESC
       LIMIT 200`
    );
    res.render('rides', { rides: list.rows, money2 });
  });

  router.get('/ledger/:driverId', async (req, res) => {
    const driverId = Number(req.params.driverId);
    const d = await q('SELECT * FROM drivers WHERE id=$1', [driverId]);
    const l = await q('SELECT * FROM balance_ledger WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 300', [driverId]);
    if (!d.rowCount) return res.redirect('/admin/drivers');
    res.render('ledger', { driver: d.rows[0], rows: l.rows, money2 });
  });

  router.post('/drivers/:id/balance', async (req, res) => {
    const id = Number(req.params.id);
    const amount = Number(req.body.amount_azn);
    const note = (req.body.note || '').trim();
    if (!Number.isFinite(amount) || amount === 0) return res.redirect('/admin/drivers');
    await q('UPDATE drivers SET balance = balance + $1 WHERE id=$2', [amount, id]);
    await q(
      "INSERT INTO balance_ledger (driver_id, kind, amount_azn, ref_table, ref_id, note) VALUES ($1,'manual',$2,'drivers',$3,$4)",
      [id, amount, id, note || 'Manual düzəliş']
    );
    res.redirect('/admin/drivers');
  });

  return router;
}
