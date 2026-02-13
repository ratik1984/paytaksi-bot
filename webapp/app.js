/* PayTaksi Telegram WebApp (Passenger + Driver) */

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
}

const qs = new URLSearchParams(location.search);
const mode = (qs.get('from') || 'passenger').toLowerCase();
const baseUrl = location.origin; // served from same backend

const $ = (id) => document.getElementById(id);

function toast(msg, type='info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => el.className = 'toast', 2600);
}

function tgUser() {
  const u = tg?.initDataUnsafe?.user;
  return u ? { id: u.id, full_name: [u.first_name, u.last_name].filter(Boolean).join(' ') } : { id: 0, full_name: '' };
}

async function postForm(url, data) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(data)) fd.append(k, v);
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) {
    let t = await res.text();
    throw new Error(t || ('HTTP ' + res.status));
  }
  return await res.json();
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

function setModeUI() {
  $('modeBadge').textContent = mode === 'driver' ? 'Sürücü' : 'Sərnişin';
  $('passengerView').style.display = mode === 'driver' ? 'none' : 'block';
  $('driverView').style.display = mode === 'driver' ? 'block' : 'none';
}

// ---------- Passenger ----------
let pickup = null;
let dest = null;

async function passengerInit() {
  const u = tgUser();
  if (!u.id) {
    toast('Telegram user tapılmadı. WebApp Telegram daxilində açılmalıdır.', 'err');
    return;
  }
  await postForm(baseUrl + '/api/passenger/init', { tg_id: u.id, full_name: u.full_name });
}

async function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation yoxdur'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 }
    );
  });
}

async function passengerDetectPickup() {
  try {
    const loc = await getLocation();
    pickup = { ...loc, address: `GPS: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` };
    $('pickupInfo').textContent = pickup.address;
    toast('Məkan tapıldı', 'ok');
  } catch (e) {
    toast('Məkan tapılmadı: ' + e.message, 'err');
  }
}

let acTimer = null;
$('destQuery')?.addEventListener('input', () => {
  clearTimeout(acTimer);
  acTimer = setTimeout(async () => {
    const q = $('destQuery').value.trim();
    if (q.length < 3) {
      $('destList').innerHTML = '';
      return;
    }
    try {
      const items = await getJson(baseUrl + '/api/destination_autocomplete?q=' + encodeURIComponent(q));
      const list = $('destList');
      list.innerHTML = '';
      items.forEach((it) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.textContent = it.display;
        div.onclick = () => {
          dest = { lat: it.lat, lng: it.lng, address: it.display };
          $('destQuery').value = it.display;
          $('destList').innerHTML = '';
          toast('Məqsəd seçildi', 'ok');
        };
        list.appendChild(div);
      });
    } catch (e) {
      // ignore
    }
  }, 350);
});

async function passengerQuote() {
  if (!pickup || !dest) return toast('Pick-up və Destination seçin', 'err');
  try {
    const q = await getJson(baseUrl + `/api/fare_quote?pickup_lat=${pickup.lat}&pickup_lng=${pickup.lng}&dest_lat=${dest.lat}&dest_lng=${dest.lng}`);
    $('quoteBox').style.display = 'block';
    $('quoteText').textContent = `Məsafə: ${q.distance_km} km • Gediş haqqı: ${q.fare_azn} AZN • Komissiya: ${q.commission_azn} AZN`;
  } catch (e) {
    toast('Quote xətası: ' + e.message, 'err');
  }
}

async function passengerRequest() {
  if (!pickup || !dest) return toast('Pick-up və Destination seçin', 'err');
  const u = tgUser();
  try {
    const r = await postForm(baseUrl + '/api/passenger/request_ride', {
      tg_id: u.id,
      full_name: u.full_name,
      pickup_lat: pickup.lat,
      pickup_lng: pickup.lng,
      pickup_address: pickup.address,
      dest_lat: dest.lat,
      dest_lng: dest.lng,
      dest_address: dest.address,
    });
    $('rideStatus').style.display = 'block';
    $('rideStatusText').textContent = `Ride #${r.ride_id} • Status: ${r.status}`;
    toast('Sifariş yaradıldı', 'ok');
  } catch (e) {
    toast('Sifariş xətası: ' + e.message, 'err');
  }
}

// ---------- Driver ----------

async function driverInit() {
  const u = tgUser();
  if (!u.id) {
    toast('Telegram user tapılmadı. WebApp Telegram daxilində açılmalıdır.', 'err');
    return;
  }
  await postForm(baseUrl + '/api/driver/init', { tg_id: u.id, full_name: u.full_name });
}

async function driverRefresh() {
  const u = tgUser();
  if (!u.id) return;
  try {
    const s = await getJson(baseUrl + '/api/driver/status?tg_id=' + encodeURIComponent(u.id));
    $('dStatus').textContent = s.status;
    $('dBalance').textContent = (Number(s.balance).toFixed(2)) + ' AZN';
    $('dOnline').textContent = s.is_online ? 'Bəli' : 'Xeyr';
    $('regYear').value = s.car_year || '';
    $('regColor').value = s.car_color || 'ağ';
  } catch {
    // ignore
  }
}

async function driverRegister() {
  const u = tgUser();
  const year = Number($('regYear').value);
  const color = $('regColor').value;
  try {
    await postForm(baseUrl + '/api/driver/register', { tg_id: u.id, full_name: u.full_name, car_year: year, car_color: color });
    toast('Qeydiyyat göndərildi (pending)', 'ok');
    await driverRefresh();
  } catch (e) {
    toast('Qeydiyyat xətası: ' + e.message, 'err');
  }
}

async function driverUpload(docType, side, inputId) {
  const u = tgUser();
  const fileInput = $(inputId);
  if (!fileInput.files || !fileInput.files[0]) return toast('Fayl seçin', 'err');
  const fd = new FormData();
  fd.append('tg_id', u.id);
  fd.append('doc_type', docType);
  fd.append('side', side);
  fd.append('file', fileInput.files[0]);
  const res = await fetch(baseUrl + '/api/driver/upload_doc', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());
  toast('Yükləndi: ' + docType + ' ' + side, 'ok');
}

async function driverToggleOnline() {
  const u = tgUser();
  const wantOnline = $('onlineToggle').checked;
  try {
    await postForm(baseUrl + '/api/driver/set_online', { tg_id: u.id, online: wantOnline });
    toast(wantOnline ? 'Online oldunuz' : 'Offline oldunuz', 'ok');
    await driverRefresh();
  } catch (e) {
    toast('Online xətası: ' + e.message, 'err');
    $('onlineToggle').checked = !wantOnline;
  }
}

async function driverUpdateLocationFromBrowser() {
  const u = tgUser();
  try {
    const loc = await getLocation();
    await postForm(baseUrl + '/api/driver/update_location', { tg_id: u.id, lat: loc.lat, lng: loc.lng });
    toast('Location yeniləndi', 'ok');
  } catch (e) {
    toast('Location xətası: ' + e.message, 'err');
  }
}

async function driverTopup() {
  const u = tgUser();
  const amount = Number($('topupAmount').value);
  const method = $('topupMethod').value;
  try {
    await postForm(baseUrl + '/api/driver/topup', { tg_id: u.id, amount_azn: amount, method });
    toast('TopUp sorğusu göndərildi (admin təsdiqi)', 'ok');
  } catch (e) {
    toast('TopUp xətası: ' + e.message, 'err');
  }
}

// ---------- Bind UI ----------

$('btnPickup')?.addEventListener('click', passengerDetectPickup);
$('btnQuote')?.addEventListener('click', passengerQuote);
$('btnRequest')?.addEventListener('click', passengerRequest);
$('btnClose')?.addEventListener('click', () => tg ? tg.close() : window.close());

$('btnRegister')?.addEventListener('click', driverRegister);
$('btnRefresh')?.addEventListener('click', driverRefresh);
$('onlineToggle')?.addEventListener('change', driverToggleOnline);
$('btnLoc')?.addEventListener('click', driverUpdateLocationFromBrowser);
$('btnTopup')?.addEventListener('click', driverTopup);

$('u_id_front')?.addEventListener('change', () => driverUpload('id_card','front','u_id_front').catch(e => toast(e.message,'err')));
$('u_id_back')?.addEventListener('change', () => driverUpload('id_card','back','u_id_back').catch(e => toast(e.message,'err')));
$('u_dl_front')?.addEventListener('change', () => driverUpload('driver_license','front','u_dl_front').catch(e => toast(e.message,'err')));
$('u_dl_back')?.addEventListener('change', () => driverUpload('driver_license','back','u_dl_back').catch(e => toast(e.message,'err')));
$('u_tp_front')?.addEventListener('change', () => driverUpload('tech_passport','front','u_tp_front').catch(e => toast(e.message,'err')));
$('u_tp_back')?.addEventListener('change', () => driverUpload('tech_passport','back','u_tp_back').catch(e => toast(e.message,'err')));

(async function boot() {
  setModeUI();
  try {
    if (mode === 'driver') {
      await driverInit();
      await driverRefresh();
    } else {
      await passengerInit();
    }
  } catch (e) {
    toast('Init xətası: ' + e.message, 'err');
  }
})();
