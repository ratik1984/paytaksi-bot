import { App } from "/js/app.js";

const root = document.getElementById("app");
try { App.requireInitDataUI(root); } catch(e) { /* dev ui shown */ }

if (App.isTg) {
  App.tg.expand();
  App.tg.ready();
}

root.innerHTML = `
  <div class="topbar">
    <div class="brand">
      <div class="logo">PT</div>
      <div>
        <div style="font-weight:800">PayTaksi</div>
        <div class="badge">Sərnişin mini-app</div>
      </div>
    </div>
    <div class="pill" id="mePill">...</div>
  </div>

  <div class="grid cols2">
    <div class="card">
      <h3 style="margin:0 0 8px 0">🚕 Sifariş ver</h3>
      <div class="small">Ünvanı yazın — avtomatik təkliflər çıxacaq. Xəritədə də görəcəksiniz.</div>

      <label>Götürüləcək yer</label>
      <div class="row">
        <input id="pickup" placeholder="Məs: 28 May m., Bakı" autocomplete="off"/>
        <button class="btn secondary" id="useMe" style="max-width:140px">📍 Mən</button>
      </div>
      <div id="pickupSug" class="list" style="margin-top:8px"></div>

      <label>Gediləcək yer</label>
      <input id="dropoff" placeholder="Məs: Gənclik m., Bakı" autocomplete="off"/>
      <div id="dropSug" class="list" style="margin-top:8px"></div>

      <div class="row" style="margin-top:10px">
        <select id="payment">
          <option value="cash">💵 Nağd</option>
          <option value="card">💳 Kart</option>
        </select>
        <button class="btn" id="create">Sifarişi göndər</button>
      </div>

      <label>Qeyd (istəyə görə)</label>
      <textarea id="note" placeholder="Məs: 2 çanta var..."></textarea>

      <hr/>
      <div id="activeRide"></div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px 0">🗺 Xəritə</h3>
      <div class="mapWrap" id="map"></div>
      <div class="small" style="margin-top:8px">Sürücü qəbul edəndə taksi markerini canlı görəcəksiniz.</div>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 8px 0">📜 Tarixçə</h3>
    <div id="history" class="list"></div>
  </div>
`;

let me = null;
let map, myMarker, pickupMarker, dropMarker, driverMarker, routeLine;
let myPos = null;
let activeRide = null;

function el(id){ return document.getElementById(id); }

async function loadMe(){
  const data = await App.api("/me");
  me = data.user;
  el("mePill").textContent = `👤 ${me.first_name || ""}  ⭐ ${Number(me.rating||5).toFixed(2)}`;
}

function initMap(){
  map = L.map("map", { zoomControl: true }).setView([40.4093, 49.8671], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap"
  }).addTo(map);

  myMarker = L.marker([40.4093,49.8671]).addTo(map).bindPopup("Siz");
}

async function locate(){
  return new Promise((resolve,reject)=>{
    if (!navigator.geolocation) return reject(new Error("no_geo"));
    navigator.geolocation.getCurrentPosition((pos)=>{
      myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      myMarker.setLatLng([myPos.lat,myPos.lng]).openPopup();
      map.setView([myPos.lat,myPos.lng], 15);
      resolve(myPos);
    }, (err)=>reject(err), { enableHighAccuracy:true, timeout:12000, maximumAge:2000 });
  });
}

async function nominatim(q){
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "Accept":"application/json" }});
  return await res.json();
}

function renderSuggestions(target, items, onPick){
  target.innerHTML = "";
  items.forEach(it=>{
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<h4 style="margin:0">${it.display_name}</h4><div class="kv"><span>lat</span><b>${Number(it.lat).toFixed(5)}</b><span>lng</span><b>${Number(it.lon).toFixed(5)}</b></div>`;
    div.onclick = ()=> onPick(it);
    target.appendChild(div);
  });
}

function setMarker(kind, lat, lng, text){
  if (kind==="pickup"){
    if (!pickupMarker) pickupMarker = L.marker([lat,lng]).addTo(map);
    pickupMarker.setLatLng([lat,lng]).bindPopup("Pickup").openPopup();
    el("pickup").value = text;
  } else {
    if (!dropMarker) dropMarker = L.marker([lat,lng]).addTo(map);
    dropMarker.setLatLng([lat,lng]).bindPopup("Dropoff").openPopup();
    el("dropoff").value = text;
  }
  map.setView([lat,lng], 15);
  drawRoute();
}

function drawRoute(){
  if (!pickupMarker || !dropMarker) return;
  const a = pickupMarker.getLatLng();
  const b = dropMarker.getLatLng();
  if (routeLine) routeLine.remove();
  routeLine = L.polyline([[a.lat,a.lng],[b.lat,b.lng]], { weight:5, opacity:0.8 }).addTo(map);
}

function rideCard(ride){
  const st = ride.status;
  const pay = ride.payment_method === "card" ? "💳 Kart" : "💵 Nağd";
  const driver = ride.driver_user_id ? `🚗 Driver: #${ride.driver_user_id}` : "🚗 Driver: axtarılır...";
  const btns = [];
  if (st === "accepted") btns.push(`<button class="btn ok" data-act="arrived">Sürücü gəldi</button>`);
  if (st === "arrived") btns.push(`<button class="btn ok" data-act="started">Yola düşdük</button>`);
  if (st === "started") btns.push(`<button class="btn ok" data-act="completed">Bitdi</button>`);
  if (!["completed","cancelled"].includes(st)) btns.push(`<button class="btn danger" data-act="cancelled">Ləğv et</button>`);
  return `
    <div class="item">
      <h4 style="margin:0 0 6px 0">Sifariş: ${ride.id}</h4>
      <div class="kv"><span>Status</span><b>${st}</b><span>${pay}</span><b>${driver}</b></div>
      <div class="small" style="margin-top:6px">📍 ${ride.pickup_text}</div>
      <div class="small">➡️ ${ride.dropoff_text}</div>
      <div class="row" style="margin-top:10px">${btns.join("")}</div>
      ${st==="completed" ? `
        <label>Reytinq (sürücü)</label>
        <div class="row">
          <select data-rate>
            <option value="5">5 ⭐</option><option value="4">4 ⭐</option><option value="3">3 ⭐</option><option value="2">2 ⭐</option><option value="1">1 ⭐</option>
          </select>
          <button class="btn" data-rate-btn>Göndər</button>
        </div>
      `:""}
    </div>
  `;
}

async function refreshHistory(){
  const data = await App.api("/rides/mine?limit=30");
  const box = el("history");
  box.innerHTML = "";
  data.rides.forEach(r=>{
    const div = document.createElement("div");
    div.className="item";
    div.innerHTML = `
      <h4 style="margin:0 0 6px 0">${r.pickup_text} → ${r.dropoff_text}</h4>
      <div class="kv"><span>${App.fmtTs(r.created_at)}</span><b>${r.status}</b><span>Ödəniş</span><b>${r.payment_method}</b></div>
    `;
    div.onclick = ()=> openRide(r.id);
    box.appendChild(div);
  });
}

async function openRide(id){
  const data = await App.api(`/rides/${id}`);
  activeRide = data.ride;
  renderActiveRide();
}

function renderActiveRide(){
  const box = el("activeRide");
  if (!activeRide) { box.innerHTML = `<div class="small">Aktiv sifariş yoxdur.</div>`; return; }
  box.innerHTML = rideCard(activeRide);

  box.querySelectorAll("[data-act]").forEach(btn=>{
    btn.onclick = async () => {
      const status = btn.getAttribute("data-act");
      await App.api(`/rides/${activeRide.id}/status`, { method:"POST", body:{ status }});
      App.toast("Yeniləndi");
    };
  });

  const rateBtn = box.querySelector("[data-rate-btn]");
  if (rateBtn) {
    rateBtn.onclick = async ()=>{
      const rating = Number(box.querySelector("[data-rate]").value);
      await App.api(`/rides/${activeRide.id}/status`, { method:"POST", body:{ status:"completed", rating }});
      App.toast("Reytinq göndərildi");
      await loadMe();
      await refreshHistory();
    };
  }
}

function ensureDriverMarker(lat,lng){
  if (!driverMarker) driverMarker = L.marker([lat,lng]).addTo(map).bindPopup("Taksi");
  driverMarker.setLatLng([lat,lng]);
}

function setupSocket(){
  const sock = io();
  sock.emit("auth", { initData: App.getInitData(), role:"passenger" });
  sock.on("auth_ok", ()=>{});

  sock.on("ride_update", ({ ride }) => {
    if (activeRide && ride.id === activeRide.id) {
      activeRide = ride;
      renderActiveRide();
      refreshHistory();
    }
  });

  sock.on("driver_location", ({ ride_id, lat, lng }) => {
    if (!activeRide || activeRide.id !== ride_id) return;
    ensureDriverMarker(lat,lng);
  });

  return sock;
}

async function main(){
  initMap();
  await loadMe();

  try { await locate(); } catch { App.toast("📍 Geolokasiya alınmadı. Manuel seçin."); }

  const pickupInput = el("pickup");
  const dropInput = el("dropoff");

  let pickupSel=null, dropSel=null;

  let t1=null;
  pickupInput.addEventListener("input", ()=>{
    clearTimeout(t1);
    const q = pickupInput.value.trim();
    if (q.length < 3) return el("pickupSug").innerHTML="";
    t1=setTimeout(async ()=>{
      const items = await nominatim(q);
      renderSuggestions(el("pickupSug"), items, (it)=>{
        pickupSel = { text: it.display_name, lat:Number(it.lat), lng:Number(it.lon) };
        setMarker("pickup", pickupSel.lat, pickupSel.lng, pickupSel.text);
        el("pickupSug").innerHTML="";
      });
    }, 350);
  });

  let t2=null;
  dropInput.addEventListener("input", ()=>{
    clearTimeout(t2);
    const q = dropInput.value.trim();
    if (q.length < 3) return el("dropSug").innerHTML="";
    t2=setTimeout(async ()=>{
      const items = await nominatim(q);
      renderSuggestions(el("dropSug"), items, (it)=>{
        dropSel = { text: it.display_name, lat:Number(it.lat), lng:Number(it.lon) };
        setMarker("dropoff", dropSel.lat, dropSel.lng, dropSel.text);
        el("dropSug").innerHTML="";
      });
    }, 350);
  });

  el("useMe").onclick = async ()=>{
    try{
      const pos = myPos || await locate();
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${pos.lat}&lon=${pos.lng}`;
      const r = await fetch(url); const j = await r.json();
      pickupSel = { text: j.display_name || "Cari yer", lat: pos.lat, lng: pos.lng };
      setMarker("pickup", pos.lat, pos.lng, pickupSel.text);
    }catch{
      App.toast("Cari yer alınmadı");
    }
  };

  el("create").onclick = async ()=>{
    if (!pickupSel) return App.toast("Pickup seçin");
    if (!dropSel) return App.toast("Dropoff seçin");
    const payment_method = el("payment").value;
    const note = el("note").value.trim() || undefined;

    const data = await App.api("/rides", { method:"POST", body:{ pickup: pickupSel, dropoff: dropSel, payment_method, note }});
    activeRide = data.ride;
    App.toast("Sifariş göndərildi");
    renderActiveRide();
    refreshHistory();
    sock.emit("join_ride", { ride_id: activeRide.id });
  };

  await refreshHistory();

  const sock = setupSocket();
  // if last ride searching, open it
  const mine = await App.api("/rides/mine?limit=1").catch(()=>null);
  if (mine?.rides?.length) {
    const r = mine.rides[0];
    if (!["completed","cancelled"].includes(r.status)) {
      activeRide = r;
      renderActiveRide();
      sock.emit("join_ride", { ride_id: r.id });
    }
  }
}

main().catch(e=>{
  console.error(e);
  if (e.message !== "initData_missing_dev") App.toast("Xəta: " + e.message);
});
