// PayTaksi Mini App - common helpers
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const API = {
  base() { return location.origin; },
  async get(path) {
    const r = await fetch(this.base() + path, { credentials: 'omit' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(this.base() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
};

function tgUser() {
  const u = tg?.initDataUnsafe?.user;
  if (!u) return null;
  return {
    id: String(u.id),
    first_name: u.first_name || '',
    last_name: u.last_name || '',
    username: u.username || ''
  };
}

function $(id){ return document.getElementById(id); }

function toast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(()=> t.style.display = 'none', 2600);
}

function debounce(fn, ms){
  let t;
  return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
}

async function nominatimSearch(q){
  const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if(!r.ok) return [];
  return r.json();
}

async function nominatimReverse(lat,lng){
  const url = 'https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if(!r.ok) return null;
  return r.json();
}
