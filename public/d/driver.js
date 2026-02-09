import { App } from "/js/app.js";

const root = document.getElementById("app");
try { App.requireInitDataUI(root); } catch(e) {}

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
        <div class="badge">Sürücü tətbiqi</div>
      </div>
    </div>
    <div class="pill" id="mePill">...</div>
  </div>

  <div class="grid cols2">
    <div class="card">
      <h3 style="margin:0 0 8px 0">🟢 Online / Offline</h3>
      <div class="row">
        <button class="btn ok" id="goOnline">Online</button>
        <button class="btn secondary" id="goOffline">Offline</button>
      </div>
      <div class="small" style="margin-top:8px">Online olanda sifarişlər gələcək. Sifariş gələndə "zəng kimi" pop-up çıxacaq.</div>

      <hr/>
      <h3 style="margin:0 0 8px 0">🚗 Profil</h3>
      <div class="row">
        <div>
          <label>Marka</label>
          <input id="carBrand" placeholder="Toyota"/>
        </div>
        <div>
          <label>Model</label>
          <input id="carModel" placeholder="Prius"/>
        </div>
      </div>
      <div class="row">
        <div>
          <label>Rəng</label>
          <input id="carColor" placeholder="Ağ"/>
        </div>
        <div>
          <label>Nömrə</label>
          <input id="carPlate" placeholder="10-AA-123"/>
        </div>
      </div>

      <label>Seçimlər</label>
      <div class="grid" style="grid-template-columns: repeat(2,1fr);gap:8px">
        ${["AC","WiFi","BabySeat","LargeTrunk","NoSmoke","PetsOK"].map(k=>`
          <label class="pill" style="cursor:pointer">
            <input type="checkbox" data-opt="${k}" style="width:auto;margin:0 8px 0 0"/> ${k}
          </label>
        `).join("")}
      </div>

      <div style="margin-top:10px">
        <button class="btn" id="saveProfile">Yadda saxla</button>
      </div>

      <hr/>
      <div id="activeRide"></div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px 0">🗺 Xəritə & Canlı izləmə</h3>
      <div class="mapWrap" id="map"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="navGoogle">Google Maps</button>
        <button class="btn secondary" id="navWaze">Waze</button>
      </div>
      <div class="small" style="margin-top:8px">Sürücü markeriniz canlı yenilənir; sərnişin də sizi görəcək.</div>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 8px 0">📜 Sifariş tarixçəsi</h3>
    <div id="history" class="list"></div>
  </div>

  <div class="overlay" id="offerOverlay">
    <div class="modal">
      <h2 style="margin:0 0 8px 0">📞 Yeni sifariş!</h2>
      <div id="offerBody" class="item"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn ok" id="acceptOffer">Qəbul et</button>
        <button class="btn danger" id="declineOffer">Rədd et</button>
      </div>
    </div>
  </div>
`;

let me=null;
let map, myMarker, pickupMarker, dropMarker, routeLine;
let myPos=null;
let activeRide=null;
let lastNavTarget=null;

const ringtone = document.getElementById("ringtone");

function el(id){ return document.getElementById(id); }

async function loadMe(){
  const data = await App.api("/me");
  me = data.user;
  el("mePill").textContent = `🚗 ${me.first_name || ""}  ⭐ ${Number(me.rating||5).toFixed(2)}`;
  if (me.role !== "driver" && me.role !== "admin") {
    App.toast("Bu səhifə sürücülər üçündür.");
  }
}

function initMap(){
  map = L.map("map").setView([40.4093, 49.8671], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  myMarker = L.marker([40.4093,49.8671]).addTo(map).bindPopup("Siz");
}

async function locate(){
  return new Promise((resolve,reject)=>{
    if (!navigator.geolocation) return reject(new Error("no_geo"));
    navigator.geolocation.watchPosition((pos)=>{
      myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      myMarker.setLatLng([myPos.lat,myPos.lng]);
      resolve(myPos);
    }, (err)=>reject(err), { enableHighAccuracy:true, maximumAge:1000, timeout:12000 });
  });
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
  const btns = [];
  if (st === "accepted") btns.push(`<button class="btn ok" data-act="arrived">Gəldim</button>`);
  if (st === "arrived") btns.push(`<button class="btn ok" data-act="started">Başladım</button>`);
  if (st === "started") btns.push(`<button class="btn ok" data-act="completed">Bitirdim</button>`);
  if (!["completed","cancelled"].includes(st)) btns.push(`<button class="btn danger" data-act="cancelled">Ləğv</button>`);

  return `
    <div class="item">
      <h4 style="margin:0 0 6px 0">Aktiv sifariş</h4>
      <div class="kv"><span>ID</span><b>${ride.id}</b><span>${pay}</span><b>${st}</b></div>
      <div class="small" style="margin-top:6px">📍 ${ride.pickup_text}</div>
      <div class="small">➡️ ${ride.dropoff_text}</div>
      ${ride.note ? `<div class="small">📝 ${ride.note}</div>`:""}
      <div class="row" style="margin-top:10px">${btns.join("")}</div>
      ${st==="completed" ? `
        <label>Reytinq (sərnişin)</label>
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

function setRideMarkers(ride){
  if (!ride) return;
  const p = { lat: ride.pickup_lat, lng: ride.pickup_lng };
  const d = { lat: ride.dropoff_lat, lng: ride.dropoff_lng };
  if (!pickupMarker) pickupMarker = L.marker([p.lat,p.lng]).addTo(map).bindPopup("Pickup");
  if (!dropMarker) dropMarker = L.marker([d.lat,d.lng]).addTo(map).bindPopup("Dropoff");
  pickupMarker.setLatLng([p.lat,p.lng]);
  dropMarker.setLatLng([d.lat,d.lng]);
  drawRoute();
  map.fitBounds([[p.lat,p.lng],[d.lat,d.lng]], { padding:[30,30] });
  lastNavTarget = d;
}

async function refreshHistory(){
  const data = await App.api("/rides/mine?limit=30");
  const box = el("history");
  box.innerHTML="";
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
  setRideMarkers(activeRide);
  sock.emit("join_ride", { ride_id: id });
}

function playRingtone(on){
  try{
    ringtone.loop = true;
    if (on) ringtone.play().catch(()=>{});
    else { ringtone.pause(); ringtone.currentTime=0; }
  }catch{}
}

function showOffer(ride){
  el("offerBody").innerHTML = `
    <h4 style="margin:0 0 6px 0">${ride.pickup_text} → ${ride.dropoff_text}</h4>
    <div class="kv"><span>Ödəniş</span><b>${ride.payment_method}</b><span>ID</span><b>${ride.id}</b></div>
    <div class="small" style="margin-top:6px">Pickup: ${ride.pickup_text}</div>
    <div class="small">Dropoff: ${ride.dropoff_text}</div>
  `;
  el("offerOverlay").classList.add("show");
  App.haptics("impact");
  playRingtone(true);
  activeRide = ride;
  setRideMarkers(ride);
}

function hideOffer(){
  el("offerOverlay").classList.remove("show");
  playRingtone(false);
}

function navUrl(provider, lat, lng){
  if (provider === "waze") return `https://waze.com/ul?ll=${lat}%2C${lng}&navigate=yes`;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

const sock = io();

async function main(){
  initMap();
  await loadMe();
  await locate().catch(()=> App.toast("Geolokasiya icazəsi lazımdır"));

  // socket auth
  sock.emit("auth", { initData: App.getInitData(), role:"driver" });

  sock.on("ride_available", ({ ride }) => {
    // broadcasted ride available - we can show as offer too, but only if online
    // keep lightweight: show toast
    App.toast("Yeni sifariş var (açın)");
  });

  sock.on("ride_offer", ({ ride }) => {
    showOffer(ride);
  });

  sock.on("ride_update", ({ ride }) => {
    if (activeRide && ride.id === activeRide.id) {
      activeRide = ride;
      renderActiveRide();
      setRideMarkers(ride);
      refreshHistory();
      if (ride.status !== "offered") hideOffer();
    }
  });

  // location push loop
  setInterval(async ()=>{
    if (!myPos) return;
    const ride_id = activeRide?.id;
    await App.api("/driver/location", { method:"POST", body:{ lat: myPos.lat, lng: myPos.lng, ride_id } }).catch(()=>{});
  }, 2500);

  el("goOnline").onclick = async ()=>{
    await App.api("/driver/online", { method:"POST", body:{ is_online:true }});
    App.toast("Online");
  };
  el("goOffline").onclick = async ()=>{
    await App.api("/driver/online", { method:"POST", body:{ is_online:false }});
    App.toast("Offline");
  };

  el("saveProfile").onclick = async ()=>{
    const options = {};
    document.querySelectorAll("[data-opt]").forEach(cb=> options[cb.getAttribute("data-opt")] = cb.checked);
    await App.api("/driver/profile", { method:"POST", body:{
      car_brand: el("carBrand").value.trim() || undefined,
      car_model: el("carModel").value.trim() || undefined,
      car_color: el("carColor").value.trim() || undefined,
      car_plate: el("carPlate").value.trim() || undefined,
      options
    }});
    App.toast("Saxlanıldı");
  };

  el("acceptOffer").onclick = async ()=>{
    if (!activeRide) return;
    hideOffer();
    const data = await App.api(`/rides/${activeRide.id}/accept`, { method:"POST" });
    activeRide = data.ride;
    renderActiveRide();
    sock.emit("join_ride", { ride_id: activeRide.id });
    App.toast("Qəbul edildi");
  };

  el("declineOffer").onclick = ()=>{
    hideOffer();
    App.toast("Rədd edildi (MVP)");
  };

  el("navGoogle").onclick = ()=>{
    if (!lastNavTarget) return App.toast("Hədəf yoxdur");
    App.openExternal(navUrl("google", lastNavTarget.lat, lastNavTarget.lng));
  };
  el("navWaze").onclick = ()=>{
    if (!lastNavTarget) return App.toast("Hədəf yoxdur");
    App.openExternal(navUrl("waze", lastNavTarget.lat, lastNavTarget.lng));
  };

  await refreshHistory();

  // auto open most recent active ride
  const mine = await App.api("/rides/mine?limit=1").catch(()=>null);
  if (mine?.rides?.length) {
    const r = mine.rides[0];
    if (!["completed","cancelled"].includes(r.status)) {
      activeRide = r;
      renderActiveRide();
      setRideMarkers(r);
      sock.emit("join_ride", { ride_id: r.id });
    }
  }
}

main().catch(e=>{
  console.error(e);
  if (e.message !== "initData_missing_dev") App.toast("Xəta: " + e.message);
});
