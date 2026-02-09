export const store = {
  get(k){ try{return JSON.parse(localStorage.getItem(k));}catch{return null} },
  set(k,v){ localStorage.setItem(k, JSON.stringify(v)); },
  del(k){ localStorage.removeItem(k); }
};

export const api = (() => {
  let token = null;
  function setToken(t){ token = t; }
  async function req(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: {
        'content-type':'application/json',
        ...(token? { 'authorization': `Bearer ${token}` }: {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'api_error');
    return j;
  }
  return {
    setToken,
    get: (url) => req('GET', url),
    post: (url, body) => req('POST', url, body),
  };
})();

export const ui = (() => {
  const app = () => document.querySelector('#app');

  function h(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstElementChild; }
  function toast(msg){
    let t = document.querySelector('.toast');
    if (!t) { t = h('<div class="toast"></div>'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t.__to);
    t.__to = setTimeout(()=>t.classList.remove('show'), 2600);
  }

  function mountShell(){
    app().innerHTML = `
      <div class="safe">
        <div class="topbar">
          <div class="wrap">
            <div class="row between">
              <div>
                <div class="title">PayTaksi</div>
                <div class="sub" id="subtitle">🚕 Telegram Mini App</div>
              </div>
              <div class="pill" id="mePill">...</div>
            </div>
          </div>
        </div>
        <div class="wrap" style="padding:14px 14px 90px">
          <div id="content"></div>
        </div>
      </div>
      <div class="call" id="call">
        <div class="box">
          <div class="row between">
            <div>
              <h2>📞 Yeni sifariş</h2>
              <div class="addr" id="callAddr"></div>
            </div>
            <span class="pill">PayTaksi</span>
          </div>
          <div class="hr"></div>
          <div class="row">
            <button class="btn danger" id="callDecline">Rədd et</button>
            <button class="btn good" id="callAccept">Qəbul et</button>
          </div>
          <div class="small" style="margin-top:10px">Səsli bildiriş: Telegram zəngi kimi sistem UI vermir — WebApp daxilində bu ekran çıxır.</div>
        </div>
      </div>
    `;
    const me = JSON.parse(localStorage.getItem('me')||'null');
    if (me) document.querySelector('#mePill').textContent = `@${me.username || me.first_name || me.tg_id}`;
  }

  function mountError(msg){
    app().innerHTML = `<div class="safe"><div class="wrap" style="padding:18px"><div class="card">${msg}</div></div></div>`;
  }

  function content(){ return document.querySelector('#content'); }
  function setSubtitle(s){ document.querySelector('#subtitle').textContent = s; }

  // MAP helper
  let map = null;
  let markers = {};
  function ensureMap(lat, lng){
    if (map) return map;
    map = L.map('map', { zoomControl: false }).setView([lat, lng], 15);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    const tile = (window.__MAP_TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    L.tileLayer(tile, { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    return map;
  }
  function setMarker(key, lat, lng, label){
    if (!map) return;
    if (!markers[key]) {
      markers[key] = L.marker([lat,lng]).addTo(map).bindPopup(label||key);
    } else {
      markers[key].setLatLng([lat,lng]);
    }
  }

  // Rider
  function renderRiderHome(){
    setSubtitle('🧍 Sərnişin — sifariş ver');
    content().innerHTML = `
      <div class="grid">
        <div class="card">
          <div id="map"></div>
          <div class="hr"></div>
          <div class="grid">
            <input class="input" id="pickup" placeholder="📍 Haradan? (avtomatik: mövcud yer)" />
            <div class="small">Pickup: xəritədə mavi marker</div>
            <input class="input" id="drop" placeholder="🏁 Haraya? (ünvan yazın)" />
            <div id="dropList" class="list"></div>
            <div class="row">
              <select id="pay" class="input">
                <option value="cash">💵 Nağd</option>
                <option value="card">💳 Kart</option>
              </select>
              <button class="btn primary" id="order">Sifariş ver</button>
            </div>
            <div class="small">Ünvan axtarışı Nominatim ilə edilir (OSM).</div>
          </div>
        </div>

        <div class="card">
          <div class="row between">
            <div>
              <div style="font-weight:800">📜 Tarixçə</div>
              <div class="small">Son 50 sifariş</div>
            </div>
            <button class="btn" id="refresh">Yenilə</button>
          </div>
          <div class="hr"></div>
          <div id="rides" class="list"></div>
        </div>
      </div>
    `;

    // map init from last location or Baku
    const last = JSON.parse(localStorage.getItem('last_pos')||'null') || { lat:40.4093, lng:49.8671 };
    ensureMap(last.lat, last.lng);
    setMarker('me', last.lat, last.lng, 'Siz');

    // geolocation update marker
    window.__onGeo = (pos) => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      localStorage.setItem('last_pos', JSON.stringify({lat,lng}));
      ensureMap(lat,lng).setView([lat,lng], 16);
      setMarker('me', lat,lng,'Siz');
      document.querySelector('#pickup').value = 'Mövcud yer (GPS)';
    };

    // drop search
    const drop = document.querySelector('#drop');
    const list = document.querySelector('#dropList');
    let dropPick = null;

    const deb = (fn, ms=450) => { let t; return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)} };
    drop.addEventListener('input', deb(async () => {
      const q = drop.value.trim();
      dropPick = null;
      list.innerHTML = '';
      if (q.length < 3) return;
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=1`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const j = await r.json();
      list.innerHTML = j.map((x,i)=>`
        <div class="item" data-i="${i}">
          <div style="font-weight:800">${x.display_name.split(',').slice(0,2).join(',')}</div>
          <div class="small">${x.display_name}</div>
        </div>
      `).join('');
      list.querySelectorAll('.item').forEach(el => el.addEventListener('click', () => {
        const x = j[Number(el.dataset.i)];
        dropPick = { lat: Number(x.lat), lng: Number(x.lon), address: x.display_name };
        drop.value = x.display_name;
        list.innerHTML = '';
        setMarker('drop', dropPick.lat, dropPick.lng, 'Drop');
        ensureMap(dropPick.lat, dropPick.lng).setView([dropPick.lat, dropPick.lng], 14);
      }));
    }, 450));

    // rides list
    async function loadRides(){
      try{
        const r = await api.get('/api/rides/my');
        const el = document.querySelector('#rides');
        if (!r.rides.length) { el.innerHTML = '<div class="small">Hələ sifariş yoxdur.</div>'; return; }
        el.innerHTML = r.rides.map(x=>`
          <div class="item">
            <div class="row between">
              <div style="font-weight:800">#${x.id} — ${x.status}</div>
              <span class="pill">${x.payment_method}</span>
            </div>
            <div class="small">📍 ${x.pickup_address}</div>
            <div class="small">🏁 ${x.drop_address}</div>
            <div class="row" style="margin-top:8px">
              <button class="btn" data-open="${x.id}">Aç</button>
              <button class="btn" data-rate="${x.id}">Reytinq</button>
            </div>
          </div>
        `).join('');
        el.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openRide(Number(b.dataset.open)));
        el.querySelectorAll('[data-rate]').forEach(b=>b.onclick=()=>rateRide(Number(b.dataset.rate)));
      }catch(e){ toast('Tarixçə yüklənmədi'); }
    }

    async function openRide(id){
      const r = await api.get(`/api/rides/${id}`);
      toast(`Ride #${id}: ${r.ride.status}`);
      if (r.ride.driver_id) {
        // request driver location via server socket events already handled
      }
    }

    async function rateRide(id){
      const stars = prompt('Sürücünü 1-5 arası qiymətləndirin:', '5');
      if (!stars) return;
      try{
        await api.post(`/api/rides/${id}/rate`, { stars: Number(stars) });
        toast('Reytinq qeyd edildi ✅');
        loadRides();
      }catch(e){
        toast('Reytinq mümkün olmadı');
      }
    }

    document.querySelector('#refresh').onclick = loadRides;
    loadRides();

    document.querySelector('#order').onclick = async () => {
      const pos = JSON.parse(localStorage.getItem('last_pos')||'null');
      if (!pos) return toast('GPS aktiv edin');
      if (!dropPick) return toast('Gediş ünvanını seçin');
      const pay = document.querySelector('#pay').value;
      try{
        const resp = await api.post('/api/rides', {
          pickup_lat: pos.lat, pickup_lng: pos.lng, pickup_address: 'Mövcud yer (GPS)',
          drop_lat: dropPick.lat, drop_lng: dropPick.lng, drop_address: dropPick.address,
          payment_method: pay,
          fare_est: 0
        });
        toast(`Sifariş yaradıldı #${resp.ride_id}`);
        loadRides();
      }catch(e){
        toast('Sifariş alınmadı');
      }
    };
  }

  // Driver
  async function renderDriverHome(){
    setSubtitle('🚗 Sürücü — online işlət');
    content().innerHTML = `
      <div class="grid">
        <div class="card" id="driverCard"></div>
        <div class="card">
          <div id="map"></div>
          <div class="small" style="margin-top:8px">Marker: Siz (sürücü). Sifariş qəbul edəndə pickup/drop görünəcək.</div>
        </div>
        <div class="card">
          <div class="row between">
            <div>
              <div style="font-weight:800">📜 Mənim sifarişlərim</div>
              <div class="small">driver history</div>
            </div>
            <button class="btn" id="dRefresh">Yenilə</button>
          </div>
          <div class="hr"></div>
          <div id="dRides" class="list"></div>
        </div>
      </div>
    `;

    const last = JSON.parse(localStorage.getItem('last_pos')||'null') || { lat:40.4093, lng:49.8671 };
    ensureMap(last.lat, last.lng);
    setMarker('me', last.lat, last.lng, 'Sürücü');

    window.__onGeo = (pos) => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      localStorage.setItem('last_pos', JSON.stringify({lat,lng}));
      setMarker('me', lat,lng,'Sürücü');
    };

    async function loadProfile(){
      const p = await api.get('/api/driver/profile');
      const box = document.querySelector('#driverCard');
      if (!p.profile) {
        box.innerHTML = `
          <div style="font-weight:900;font-size:16px">Qeydiyyat lazımdır</div>
          <div class="small">Telefon + maşın məlumatları + sənədlər foto. Sonra admin təsdiq edəcək.</div>
          <div class="hr"></div>
          ${driverRegisterForm()}
        `;
        wireRegister();
        return;
      }
      const st = p.profile.status;
      const badge = st==='approved' ? '✅ Təsdiqli' : (st==='pending' ? '⏳ Gözləyir' : '❌ Rədd edilib');
      box.innerHTML = `
        <div class="row between">
          <div>
            <div style="font-weight:900;font-size:16px">Profil: ${badge}</div>
            <div class="small">${p.profile.car_brand} ${p.profile.car_model} • ${p.profile.car_color} • ${p.profile.car_plate}</div>
          </div>
          <button class="btn" id="reReg">Yenidən göndər</button>
        </div>
        <div class="hr"></div>
        <div class="row">
          <button class="btn good" id="goOnline" ${st==='approved'?'':'disabled'}>Online ol</button>
          <button class="btn" id="how">Qaydalar</button>
        </div>
        ${st==='rejected' ? `<div class="small" style="margin-top:10px">Qeyd: ${p.profile.review_note || 'Rədd'}</div>`:''}
      `;
      document.querySelector('#reReg').onclick = () => { box.innerHTML = driverRegisterForm(); wireRegister(); };
      document.querySelector('#how').onclick = () => toast('Online ol → sifariş gələcək. Gəldikdə qəbul et/bitir.');
      document.querySelector('#goOnline').onclick = async () => {
        try{ await api.post('/api/driver/online', {}); toast('Online ✅'); }
        catch(e){ toast('Online olmadı'); }
      };
    }

    function driverRegisterForm(){
      return `
        <form id="regForm" class="grid">
          <input class="input" name="phone" placeholder="📞 Telefon nömrəsi" required />
          <div class="row">
            <input class="input" name="car_brand" placeholder="Marka" required />
            <input class="input" name="car_model" placeholder="Model" required />
          </div>
          <div class="row">
            <input class="input" name="car_color" placeholder="Rəng" required />
            <input class="input" name="car_plate" placeholder="Dövlət nömrəsi" required />
          </div>
          <input class="input" name="car_year" placeholder="Avtomobil ili (məs: 2017)" required />
          <div class="small">Sənədlər (məcburi):</div>
          <div class="grid">
            <label class="small">Avtomobil qeydiyyat sənədi (ön): <input type="file" name="car_reg_front" required /></label>
            <label class="small">Avtomobil qeydiyyat sənədi (arxa): <input type="file" name="car_reg_back" required /></label>
            <label class="small">Ş/V (ön): <input type="file" name="id_front" required /></label>
            <label class="small">Ş/V (arxa): <input type="file" name="id_back" required /></label>
            <label class="small">Sürücülük vəsiqəsi (ön): <input type="file" name="license_front" required /></label>
            <label class="small">Sürücülük vəsiqəsi (arxa): <input type="file" name="license_back" required /></label>
          </div>
          <button class="btn primary" type="submit">Qeydiyyatı göndər</button>
        </form>
      `;
    }

    function wireRegister(){
      const form = document.querySelector('#regForm');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const token = JSON.parse(localStorage.getItem('token'));
        const r = await fetch('/api/driver/register', {
          method:'POST',
          headers: { 'authorization': `Bearer ${token}` },
          body: fd
        });
        const j = await r.json();
        if (!j.ok) return toast('Göndərilmədi: '+(j.error||'xəta'));
        toast('Göndərildi ✅ (admin təsdiqi gözlənir)');
        loadProfile();
      };
    }

    async function loadRides(){
      const r = await api.get('/api/rides/my');
      const el = document.querySelector('#dRides');
      el.innerHTML = r.rides.filter(x=>x.driver_id).map(x=>`
        <div class="item">
          <div class="row between">
            <div style="font-weight:800">#${x.id} — ${x.status}</div>
            <span class="pill">${x.payment_method}</span>
          </div>
          <div class="small">📍 ${x.pickup_address}</div>
          <div class="small">🏁 ${x.drop_address}</div>
          <div class="row" style="margin-top:8px">
            <button class="btn" data-open="${x.id}">Aç</button>
            <button class="btn good" data-start="${x.id}">Start</button>
            <button class="btn primary" data-done="${x.id}">Bitir</button>
          </div>
        </div>
      `).join('') || '<div class="small">Hələ ride yoxdur.</div>';

      el.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openRide(Number(b.dataset.open)));
      el.querySelectorAll('[data-start]').forEach(b=>b.onclick=()=>api.post(`/api/rides/${b.dataset.start}/start`,{}).then(()=>toast('Trip başladı')).catch(()=>toast('Olmadı')));
      el.querySelectorAll('[data-done]').forEach(b=>b.onclick=()=>api.post(`/api/rides/${b.dataset.done}/complete`,{}).then(()=>toast('Bitdi')).catch(()=>toast('Olmadı')));
    }

    async function openRide(id){
      const r = await api.get(`/api/rides/${id}`);
      toast(`Ride #${id}: ${r.ride.status}`);
      setMarker('pickup', r.ride.pickup_lat, r.ride.pickup_lng, 'Pickup');
      setMarker('drop', r.ride.drop_lat, r.ride.drop_lng, 'Drop');
    }

    document.querySelector('#dRefresh').onclick = loadRides;
    await loadProfile();
    await loadRides();
  }

  // Admin
  async function renderAdminHome(){
    setSubtitle('🛠 Admin — nəzarət');
    content().innerHTML = `
      <div class="grid">
        <div class="card" id="sum">Yüklənir...</div>
        <div class="card">
          <div class="row between">
            <div>
              <div style="font-weight:900">🚗 Sürücülər</div>
              <div class="small">Pending/Approved/Rejected</div>
            </div>
            <button class="btn" id="aRefresh">Yenilə</button>
          </div>
          <div class="hr"></div>
          <div id="drivers" class="list"></div>
        </div>
        <div class="card">
          <div class="row between">
            <div>
              <div style="font-weight:900">🧾 Ride-lər</div>
              <div class="small">Son 200</div>
            </div>
            <button class="btn" id="rRefresh">Yenilə</button>
          </div>
          <div class="hr"></div>
          <div id="rides" class="list"></div>
        </div>
      </div>
    `;

    async function load(){
      const s = await api.get('/api/admin/summary');
      document.querySelector('#sum').innerHTML = `
        <div class="row between">
          <div class="pill">Users: <b>${s.users}</b></div>
          <div class="pill">Rides: <b>${s.rides}</b></div>
          <div class="pill">Pending: <b>${s.pending_drivers}</b></div>
        </div>
        <div class="small" style="margin-top:10px">ADMIN_IDS ilə idarə olunur.</div>
      `;

      const d = await api.get('/api/admin/drivers');
      document.querySelector('#drivers').innerHTML = d.drivers.map(x=>{
        const st = x.status;
        const badge = st==='approved'?'✅':(st==='pending'?'⏳':'❌');
        return `
          <div class="item">
            <div class="row between">
              <div style="font-weight:900">${badge} ${x.first_name||''} ${x.last_name||''} (@${x.username||'—'})</div>
              <span class="pill">${st}</span>
            </div>
            <div class="small">📞 ${x.phone||'—'}</div>
            <div class="small">🚘 ${x.car_brand} ${x.car_model} • ${x.car_color} • ${x.car_plate} • ${x.car_year}</div>
            <div class="row" style="margin-top:8px">
              <a class="btn" href="${x.docs?.car_reg_front||'#'}" target="_blank">Sənəd 1</a>
              <a class="btn" href="${x.docs?.license_front||'#'}" target="_blank">Vəsiqə</a>
              <button class="btn good" data-ap="${x.user_id}">Approve</button>
              <button class="btn danger" data-rj="${x.user_id}">Reject</button>
            </div>
            ${x.review_note?`<div class="small" style="margin-top:6px">Qeyd: ${x.review_note}</div>`:''}
          </div>
        `;
      }).join('') || '<div class="small">Sürücü yoxdur.</div>';

      document.querySelectorAll('[data-ap]').forEach(b=>b.onclick=async()=>{
        await api.post(`/api/admin/drivers/${b.dataset.ap}/approve`,{});
        toast('Approve ✅');
        load();
      });
      document.querySelectorAll('[data-rj]').forEach(b=>b.onclick=async()=>{
        const note = prompt('Rədd səbəbi:', 'Sənədlər uyğun deyil') || '';
        await api.post(`/api/admin/drivers/${b.dataset.rj}/reject`,{ note });
        toast('Reject ✅');
        load();
      });

      const r = await api.get('/api/admin/rides');
      document.querySelector('#rides').innerHTML = r.rides.map(x=>`
        <div class="item">
          <div class="row between">
            <div style="font-weight:900">#${x.id} — ${x.status}</div>
            <span class="pill">${x.payment_method}</span>
          </div>
          <div class="small">👤 Rider: @${x.rider_username||'—'} (${x.rider_tg_id})</div>
          <div class="small">🚗 Driver: @${x.driver_username||'—'} (${x.driver_tg_id||'—'})</div>
          <div class="small">📍 ${x.pickup_address}</div>
          <div class="small">🏁 ${x.drop_address}</div>
        </div>
      `).join('') || '<div class="small">Ride yoxdur.</div>';
    }

    document.querySelector('#aRefresh').onclick = load;
    document.querySelector('#rRefresh').onclick = load;
    load();
  }

  // Incoming ride UI (driver)
  async function onIncomingRide(rideId){
    try{
      const me = JSON.parse(localStorage.getItem('me')||'{}');
      if (me.role !== 'driver') return;
      const r = await api.get(`/api/rides/${rideId}`);
      const ride = r.ride;
      const call = document.querySelector('#call');
      document.querySelector('#callAddr').innerHTML = `
        <div>📍 <b>${ride.pickup_address}</b></div>
        <div>🏁 ${ride.drop_address}</div>
        <div class="small">Ödəniş: ${ride.payment_method}</div>
      `;
      call.classList.add('show');

      // ring
      const ring = document.querySelector('#ring');
      ring.currentTime = 0;
      ring.play().catch(()=>{});

      document.querySelector('#callAccept').onclick = async () => {
        ring.pause();
        call.classList.remove('show');
        await api.post(`/api/rides/${rideId}/accept`, {});
        toast('Qəbul edildi ✅');
        // show markers
        setMarker('pickup', ride.pickup_lat, ride.pickup_lng, 'Pickup');
        setMarker('drop', ride.drop_lat, ride.drop_lng, 'Drop');
      };
      document.querySelector('#callDecline').onclick = async () => {
        ring.pause();
        call.classList.remove('show');
        await api.post(`/api/rides/${rideId}/decline`, {});
        toast('Rədd edildi');
      };
    }catch(e){
      toast('Incoming ride error');
    }
  }

  async function onRideUpdate(rideId){
    // Best-effort: refresh history blocks if present
    const p = location.pathname;
    if (p.startsWith('/rider')) {
      const btn = document.querySelector('#refresh');
      if (btn) btn.click();
    }
    if (p.startsWith('/driver')) {
      const btn = document.querySelector('#dRefresh');
      if (btn) btn.click();
    }
  }

  return {
    toast,
    mountShell,
    mountError,
    renderRiderHome,
    renderDriverHome,
    renderAdminHome,
    onIncomingRide,
    onRideUpdate,
  };
})();

export const geo = (() => {
  let watchId = null;
  function start(onPos){
    if (!navigator.geolocation) return;
    if (watchId) return;
    watchId = navigator.geolocation.watchPosition((pos)=>{
      try{ window.__onGeo?.(pos); }catch{}
      onPos?.(pos);
    }, (err)=>{
      console.log('geo err', err);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  }
  function stop(){
    if (watchId) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  return { start, stop };
})();

export const mapui = (() => {
  // Right now we only support updating remote marker for driver/rider (best-effort)
  function onRemoteLocation(p){
    // reserved for future: show driver marker in rider UI or rider marker in driver UI
    // For simplicity, use global Leaflet map access via window.L (already in ui).
    // This module remains as a placeholder for expansion.
  }
  return { onRemoteLocation };
})();

export const auth = {};
