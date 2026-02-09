import { api, auth, store, ui, geo, mapui } from './modules.js';

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
}

function route() {
  const p = location.pathname;
  if (p.startsWith('/driver')) return 'driver';
  if (p.startsWith('/admin')) return 'admin';
  return 'rider';
}

async function ensureAuth() {
  const token = store.get('token');
  if (token) return token;

  const initData = tg?.initData || '';
  if (!initData) {
    ui.mountError('Bu səhifə Telegram içində açılmalıdır (WebApp).');
    throw new Error('no_initdata');
  }
  const r = await fetch('/api/auth/webapp', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ initData }),
  });
  const j = await r.json();
  if (!j.ok) {
    ui.mountError('Giriş alınmadı. Botdan /start edin və yenidən açın.');
    throw new Error('auth_failed');
  }
  store.set('token', j.token);
  return j.token;
}

async function start() {
  ui.mountShell();
  const token = await ensureAuth();
  api.setToken(token);

  const meRes = await api.get('/api/me');
  const me = meRes.me;
  store.set('me', me);

  const role = route();
  if (role === 'admin' && me.role !== 'admin') {
    ui.toast('Admin hüququ yoxdur.');
    ui.renderRiderHome();
    return;
  }

  if (role === 'driver') {
    ui.renderDriverHome();
  } else if (role === 'admin') {
    ui.renderAdminHome();
  } else {
    ui.renderRiderHome();
  }

  // Live location loop (optional)
  geo.start(async (pos) => {
    await api.post('/api/location', {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      heading: pos.coords.heading,
      speed: pos.coords.speed,
    });
  });

  // Socket
  const socket = io({ auth: { token } });
  socket.on('connect', () => console.log('socket connected'));
  socket.on('location:update', (p) => mapui.onRemoteLocation(p));
  socket.on('ride:incoming', async ({ ride_id }) => ui.onIncomingRide(ride_id));
  socket.on('ride:update', async ({ ride_id }) => ui.onRideUpdate(ride_id));

  window.__socket = socket;
}

start().catch((e) => console.error(e));
