// PayTaksi Passenger Mini App (Bolt-like MVP)

const tg = window.Telegram?.WebApp;
try {
  tg?.expand?.();
  tg?.ready?.();
} catch {}

const state = {
  me: null,
  pickup: null,
  dest: null,
  requestId: null,
  polling: null,
};

const $ = (id) => document.getElementById(id);

const ui = {
  pickupInput: $('pickupInput'),
  pickupHint: $('pickupHint'),
  destInput: $('destInput'),
  destResults: $('destResults'),
  distance: $('distance'),
  fare: $('fare'),
  btnOrder: $('btnOrder'),
  btnCancel: $('btnCancel'),
  btnClose: $('btnClose'),
  btnLocate: $('btnLocate'),
  stepSearch: $('stepSearch'),
  stepSearching: $('stepSearching'),
  stepMatched: $('stepMatched'),
  searchInfo: $('searchInfo'),
  matchedInfo: $('matchedInfo'),
};

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (tg?.initData) h['x-telegram-init-data'] = tg.initData;
  return h;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...headers(), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

// --- Map
const map = L.map('map', { zoomControl: false });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

let pickupMarker = null;
let destMarker = null;
let line = null;

function setMarkers() {
  if (pickupMarker) pickupMarker.remove();
  if (destMarker) destMarker.remove();
  if (line) line.remove();

  if (state.pickup) {
    pickupMarker = L.marker([state.pickup.lat, state.pickup.lng]).addTo(map);
  }
  if (state.dest) {
    destMarker = L.marker([state.dest.lat, state.dest.lng]).addTo(map);
  }
  if (state.pickup && state.dest) {
    line = L.polyline(
      [
        [state.pickup.lat, state.pickup.lng],
        [state.dest.lat, state.dest.lng],
      ],
      { weight: 5, opacity: 0.8 }
    ).addTo(map);
    const b = line.getBounds().pad(0.25);
    map.fitBounds(b);
  } else if (state.pickup) {
    map.setView([state.pickup.lat, state.pickup.lng], 15);
  }
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function calcFare(distanceKm) {
  // Mirrors backend defaults: base 3.50 for up to 3km, after that 0.40/km
  const base = 3.5;
  const baseKm = 3;
  const per = 0.4;
  const d = Math.max(0, Number(distanceKm || 0));
  const n = d <= baseKm ? base : base + (d - baseKm) * per;
  return Math.round(n * 100) / 100;
}

function updateEstimate() {
  if (!state.pickup || !state.dest) {
    ui.distance.textContent = '—';
    ui.fare.textContent = '—';
    ui.btnOrder.disabled = true;
    return;
  }
  const km = haversineKm(state.pickup, state.dest);
  const fare = calcFare(km);
  ui.distance.textContent = km.toFixed(1) + ' km';
  ui.fare.textContent = fare.toFixed(2) + ' AZN';
  ui.btnOrder.disabled = false;
}

// --- Location
async function locate() {
  ui.pickupHint.textContent = 'Yer müəyyən edilir…';
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        state.pickup = { lat, lng, text: 'Cari yer' };
        ui.pickupInput.value = 'Cari yer';
        ui.pickupHint.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        setMarkers();
        updateEstimate();
        resolve();
      },
      (err) => {
        ui.pickupHint.textContent = 'Yer icazəsi verilmədi.';
        reject(err);
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });
}

ui.btnLocate.addEventListener('click', () => locate().catch(() => {}));

// --- Address search (Nominatim)
let destTimer = null;
async function searchDest(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'Accept-Language': 'az' } });
  const arr = await r.json();
  return arr;
}

function clearResults() {
  ui.destResults.innerHTML = '';
}

function renderResults(items) {
  clearResults();
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'result';
    const title = it.display_name.split(',').slice(0, 2).join(', ');
    div.innerHTML = `<div class="t">${escapeHtml(title)}</div><div class="s">${escapeHtml(it.display_name)}</div>`;
    div.addEventListener('click', () => {
      state.dest = { lat: Number(it.lat), lng: Number(it.lon), text: it.display_name };
      ui.destInput.value = title;
      clearResults();
      setMarkers();
      updateEstimate();
    });
    ui.destResults.appendChild(div);
  }
}

ui.destInput.addEventListener('input', () => {
  const v = ui.destInput.value.trim();
  state.dest = null;
  updateEstimate();
  if (destTimer) clearTimeout(destTimer);
  if (v.length < 3) {
    clearResults();
    return;
  }
  destTimer = setTimeout(async () => {
    try {
      const items = await searchDest(v);
      renderResults(items);
    } catch {
      // ignore
    }
  }, 300);
});

// --- Ordering flow
function showStep(name) {
  ui.stepSearch.classList.toggle('hidden', name !== 'search');
  ui.stepSearching.classList.toggle('hidden', name !== 'searching');
  ui.stepMatched.classList.toggle('hidden', name !== 'matched');
}

async function startPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(async () => {
    if (!state.requestId) return;
    try {
      const s = await api(`/api/mini/passenger/status?request_id=${state.requestId}`);
      if (s.ride && (s.ride.status === 'accepted' || s.ride.status === 'arrived' || s.ride.status === 'started')) {
        showStep('matched');
        ui.matchedInfo.textContent = `Sifariş #${state.requestId} · Sürücü götürdü.`;
        clearInterval(state.polling);
        state.polling = null;
      }
      if (s.request && s.request.status === 'cancelled') {
        showStep('search');
        clearInterval(state.polling);
        state.polling = null;
        state.requestId = null;
      }
    } catch {
      // ignore
    }
  }, 2500);
}

ui.btnOrder.addEventListener('click', async () => {
  try {
    showStep('searching');
    ui.searchInfo.textContent = `${ui.distance.textContent} · ${ui.fare.textContent}`;
    const km = haversineKm(state.pickup, state.dest);
    const r = await api('/api/mini/passenger/request', {
      method: 'POST',
      body: JSON.stringify({
        pickup: state.pickup,
        dest: state.dest,
        distance_km: km,
      }),
    });
    state.requestId = r.request.id;
    await startPolling();
  } catch (e) {
    showStep('search');
    alert('Xəta: ' + (e.message || '')); 
  }
});

ui.btnCancel.addEventListener('click', async () => {
  try {
    if (state.requestId) {
      await api('/api/mini/passenger/cancel', {
        method: 'POST',
        body: JSON.stringify({ request_id: state.requestId }),
      });
    }
  } catch {}
  state.requestId = null;
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
  showStep('search');
});

ui.btnClose.addEventListener('click', () => {
  try {
    tg?.close?.();
  } catch {
    // fallback
    showStep('search');
  }
});

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// --- Boot
(async function init() {
  // Center on Baku by default
  map.setView([40.4093, 49.8671], 12);

  // Warm up API
  try {
    const me = await api('/api/mini/passenger/me');
    state.me = me.user;
  } catch (e) {
    // If opened outside Telegram, show note
    console.warn('MiniApp auth failed', e);
  }

  // Get pickup
  try {
    await locate();
  } catch {
    ui.pickupHint.textContent = 'Yer icazəsi verin (GPS).';
  }

  updateEstimate();
})();
