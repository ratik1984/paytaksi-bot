import express from 'express';
import multer from 'multer';
import { cfg } from '../config.js';
import { q } from '../db.js';
import { bumpDriverBalance } from '../utils/dbHelpers.js';

const upload = multer({ dest: 'uploads/' });

function basicAuth(req, res, next) {
  const h = req.headers['authorization'] || '';
  const [typ, val] = h.split(' ');
  if (typ !== 'Basic' || !val) {
    res.set('WWW-Authenticate', 'Basic realm="PayTaksi Admin"');
    return res.status(401).send('Auth required');
  }
  const [user, pass] = Buffer.from(val, 'base64').toString('utf8').split(':');
  if (user === cfg.adminWebUser && pass === cfg.adminWebPass) return next();
  res.set('WWW-Authenticate', 'Basic realm="PayTaksi Admin"');
  return res.status(401).send('Invalid credentials');
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{font-family:system-ui,Arial;max-width:1100px;margin:20px auto;padding:0 12px;}
    .top{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
    a{color:#0a58ca;text-decoration:none}
    table{border-collapse:collapse;width:100%;}
    th,td{border:1px solid #ddd;padding:8px;font-size:14px;}
    th{background:#f5f5f5;text-align:left}
    .badge{padding:2px 8px;border-radius:999px;background:#eee;}
    .ok{background:#d1e7dd;}
    .warn{background:#fff3cd;}
    .bad{background:#f8d7da;}
    .btn{padding:6px 10px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}
    .btn-primary{background:#0a58ca;color:#fff;border-color:#0a58ca}
    .btn-danger{background:#dc3545;color:#fff;border-color:#dc3545}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0}
    .card{border:1px solid #ddd;border-radius:12px;padding:12px}
  </style>
  </head><body>
  <div class="top">
    <h2 style="margin:0">PayTaksi Admin</h2>
    <span class="badge">${new Date().toLocaleString()}</span>
    <span style="flex:1"></span>
    <a href="/admin">Dashboard</a>
    <a href="/admin/drivers">Drivers</a>
    <a href="/admin/topups">Topups</a>
    <a href="/admin/rides">Rides</a>
  </div>
  <hr/>
  ${body}
  </body></html>`;
}

export function buildAdminWeb() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  app.get('/admin', basicAuth, async (req, res) => {
    const [drivers, pendingDrivers, pendingTopups, ridesToday] = await Promise.all([
      q("SELECT COUNT(*)::int c FROM driver_profiles"),
      q("SELECT COUNT(*)::int c FROM driver_profiles WHERE status='pending'"),
      q("SELECT COUNT(*)::int c FROM topup_requests WHERE status='pending'"),
      q("SELECT COUNT(*)::int c FROM rides WHERE created_at >= NOW() - interval '24 hours'"),
    ]);

    const body = `
      <div class="grid">
        <div class="card"><div>Drivers</div><h3>${drivers.rows[0].c}</h3></div>
        <div class="card"><div>Pending drivers</div><h3>${pendingDrivers.rows[0].c}</h3></div>
        <div class="card"><div>Pending topups</div><h3>${pendingTopups.rows[0].c}</h3></div>
        <div class="card"><div>Rides (24h)</div><h3>${ridesToday.rows[0].c}</h3></div>
      </div>
      <p>Tip: Drivers təsdiqi və Topup təsdiqi buradan edilir.</p>
    `;
    res.send(page('Dashboard', body));
  });

  app.get('/admin/drivers', basicAuth, async (req, res) => {
    const r = await q(
      `SELECT u.id,u.tg_id,u.first_name,u.last_name,u.phone,
              d.car_make,d.car_model,d.car_plate,d.status,d.balance_azn
       FROM users u JOIN driver_profiles d ON d.user_id=u.id
       ORDER BY u.id DESC LIMIT 200`
    );

    const rows = r.rows
      .map((x) => {
        const badge = x.status === 'approved' ? 'ok' : x.status === 'pending' ? 'warn' : 'bad';
        return `<tr>
          <td>${x.id}</td>
          <td>${x.tg_id}</td>
          <td>${(x.first_name || '') + ' ' + (x.last_name || '')}</td>
          <td>${x.phone || ''}</td>
          <td>${(x.car_make || '') + ' ' + (x.car_model || '')}</td>
          <td>${x.car_plate || ''}</td>
          <td><span class="badge ${badge}">${x.status}</span></td>
          <td>${Number(x.balance_azn).toFixed(2)}</td>
          <td style="white-space:nowrap">
            <form method="post" action="/admin/drivers/${x.id}/approve" style="display:inline">
              <button class="btn btn-primary" type="submit">Approve</button>
            </form>
            <form method="post" action="/admin/drivers/${x.id}/reject" style="display:inline">
              <button class="btn btn-danger" type="submit">Reject</button>
            </form>
          </td>
        </tr>`;
      })
      .join('');

    res.send(
      page(
        'Drivers',
        `<h3>Drivers</h3>
        <table>
          <thead><tr><th>ID</th><th>TG</th><th>Name</th><th>Phone</th><th>Car</th><th>Plate</th><th>Status</th><th>Balance</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      )
    );
  });

  app.post('/admin/drivers/:id/approve', basicAuth, async (req, res) => {
    const id = Number(req.params.id);
    await q("UPDATE driver_profiles SET status='approved', updated_at=NOW() WHERE user_id=$1", [id]);
    res.redirect('/admin/drivers');
  });

  app.post('/admin/drivers/:id/reject', basicAuth, async (req, res) => {
    const id = Number(req.params.id);
    await q("UPDATE driver_profiles SET status='rejected', updated_at=NOW() WHERE user_id=$1", [id]);
    res.redirect('/admin/drivers');
  });

  app.get('/admin/topups', basicAuth, async (req, res) => {
    const r = await q(
      `SELECT t.id,t.method,t.amount_azn,t.status,t.created_at,u.id as user_id,u.tg_id,u.first_name,u.last_name
       FROM topup_requests t JOIN users u ON u.id=t.driver_id
       ORDER BY t.id DESC LIMIT 200`
    );

    const rows = r.rows
      .map((x) => {
        const badge = x.status === 'approved' ? 'ok' : x.status === 'pending' ? 'warn' : 'bad';
        return `<tr>
          <td>${x.id}</td>
          <td>${x.user_id} (tg:${x.tg_id})</td>
          <td>${(x.first_name || '') + ' ' + (x.last_name || '')}</td>
          <td>${x.method}</td>
          <td>${Number(x.amount_azn).toFixed(2)}</td>
          <td><span class="badge ${badge}">${x.status}</span></td>
          <td>${new Date(x.created_at).toLocaleString()}</td>
          <td style="white-space:nowrap">
            <form method="post" action="/admin/topups/${x.id}/approve" style="display:inline">
              <button class="btn btn-primary" type="submit">Approve</button>
            </form>
            <form method="post" action="/admin/topups/${x.id}/reject" style="display:inline">
              <button class="btn btn-danger" type="submit">Reject</button>
            </form>
          </td>
        </tr>`;
      })
      .join('');

    res.send(
      page(
        'Topups',
        `<h3>Topup requests</h3>
        <table>
          <thead><tr><th>ID</th><th>Driver</th><th>Name</th><th>Method</th><th>Amount</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      )
    );
  });

  app.post('/admin/topups/:id/approve', basicAuth, async (req, res) => {
    const id = Number(req.params.id);
    const r = await q('SELECT * FROM topup_requests WHERE id=$1', [id]);
    const t = r.rows[0];
    if (t && t.status === 'pending') {
      await q("UPDATE topup_requests SET status='approved', updated_at=NOW() WHERE id=$1", [id]);
      await bumpDriverBalance(Number(t.driver_id), Number(t.amount_azn), 'topup', { topupId: id, method: t.method });
    }
    res.redirect('/admin/topups');
  });

  app.post('/admin/topups/:id/reject', basicAuth, async (req, res) => {
    const id = Number(req.params.id);
    await q("UPDATE topup_requests SET status='rejected', updated_at=NOW() WHERE id=$1", [id]);
    res.redirect('/admin/topups');
  });

  app.get('/admin/rides', basicAuth, async (req, res) => {
    const r = await q(
      `SELECT id,status,passenger_id,driver_id,fare_azn,commission_azn,created_at,completed_at
       FROM rides ORDER BY id DESC LIMIT 200`
    );

    const rows = r.rows
      .map(
        (x) => `<tr>
        <td>${x.id}</td>
        <td>${x.status}</td>
        <td>${x.passenger_id}</td>
        <td>${x.driver_id}</td>
        <td>${Number(x.fare_azn || 0).toFixed(2)}</td>
        <td>${Number(x.commission_azn || 0).toFixed(2)}</td>
        <td>${new Date(x.created_at).toLocaleString()}</td>
        <td>${x.completed_at ? new Date(x.completed_at).toLocaleString() : ''}</td>
      </tr>`
      )
      .join('');

    res.send(
      page(
        'Rides',
        `<h3>Rides</h3>
        <table>
          <thead><tr><th>ID</th><th>Status</th><th>Passenger</th><th>Driver</th><th>Fare</th><th>Commission</th><th>Created</th><th>Completed</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      )
    );
  });

  return app;
}
