const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

export function getInitData() {
  return tg?.initData || '';
}

export async function api(path, { method = 'GET', body } = {}) {
  const initData = getInitData();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-InitData': initData
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 20);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 2500);
}

export function openMaps(lat, lon, label) {
  const url = `https://www.google.com/maps?q=${encodeURIComponent(lat + ',' + lon)}(${encodeURIComponent(label || 'PayTaksi')})`;
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, '_blank');
}
