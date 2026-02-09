import { App } from "/js/app.js";

const root = document.getElementById("app");
try { App.requireInitDataUI(root); } catch(e) {}

if (App.isTg) { App.tg.expand(); App.tg.ready(); }

root.innerHTML = `
  <div class="topbar">
    <div class="brand">
      <div class="logo">PT</div>
      <div>
        <div style="font-weight:800">PayTaksi</div>
        <div class="badge">Admin panel</div>
      </div>
    </div>
    <div class="pill" id="mePill">...</div>
  </div>

  <div class="grid cols2">
    <div class="card">
      <h3 style="margin:0 0 8px 0">📊 Statistika</h3>
      <div id="stats" class="list"></div>
    </div>
    <div class="card">
      <h3 style="margin:0 0 8px 0">🟢 Online sürücülər</h3>
      <div id="drivers" class="list"></div>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 8px 0">📥 Açıq sifarişlər</h3>
    <div class="small">Sifarişi sürücüyə təyin edin (assign). Sürücüyə dərhal "zəng" pop-up gedəcək.</div>
    <div id="rides" class="list" style="margin-top:10px"></div>
  </div>
`;

let me=null;
let drivers=[];
let rides=[];
let selectedDriver=null;

function el(id){ return document.getElementById(id); }

async function loadMe(){
  const data = await App.api("/me");
  me = data.user;
  el("mePill").textContent = `🛠 ${me.first_name||""} (admin)`;
}

function renderStats(s){
  const box = el("stats");
  box.innerHTML = "";
  const a = document.createElement("div");
  a.className="item";
  a.innerHTML = `<h4 style="margin:0 0 6px 0">Users</h4>` +
    (s.users||[]).map(x=>`<div class="kv"><span>${x.role}</span><b>${x.c}</b></div>`).join("");
  box.appendChild(a);

  const b = document.createElement("div");
  b.className="item";
  b.innerHTML = `<h4 style="margin:0 0 6px 0">Rides</h4>` +
    (s.ridesByStatus||[]).map(x=>`<div class="kv"><span>${x.status}</span><b>${x.c}</b></div>`).join("");
  box.appendChild(b);
}

function renderDrivers(){
  const box = el("drivers");
  box.innerHTML="";
  drivers.forEach(d=>{
    const div = document.createElement("div");
    div.className="item";
    const name = d.username ? `@${d.username}` : (d.first_name || `Driver#${d.user_id}`);
    div.innerHTML = `
      <h4 style="margin:0 0 6px 0">${name}</h4>
      <div class="kv"><span>⭐</span><b>${Number(d.rating||5).toFixed(2)}</b><span>Seats</span><b>${d.seats||4}</b></div>
      <div class="small">${[d.car_brand,d.car_model,d.car_color,d.car_plate].filter(Boolean).join(" • ") || "Profil boşdur"}</div>
      <div class="small">${d.last_lat ? `📍 ${Number(d.last_lat).toFixed(5)}, ${Number(d.last_lng).toFixed(5)}`:""}</div>
      <button class="btn secondary" style="margin-top:10px" data-pick>Bu sürücünü seç</button>
    `;
    div.querySelector("[data-pick]").onclick = ()=>{
      selectedDriver = d;
      App.toast("Seçildi: " + name);
      renderRides();
    };
    box.appendChild(div);
  });
}

function renderRides(){
  const box = el("rides");
  box.innerHTML="";
  rides.forEach(r=>{
    const div = document.createElement("div");
    div.className="item";
    const canAssign = !!selectedDriver && (r.status==="searching" || r.status==="offered");
    div.innerHTML = `
      <h4 style="margin:0 0 6px 0">${r.pickup_text} → ${r.dropoff_text}</h4>
      <div class="kv"><span>ID</span><b>${r.id}</b><span>Status</span><b>${r.status}</b></div>
      <div class="kv"><span>Payment</span><b>${r.payment_method}</b><span>Passenger</span><b>#${r.passenger_user_id}</b></div>
      <div class="row" style="margin-top:10px">
        <button class="btn ${canAssign ? "" : "secondary"}" data-assign ${canAssign ? "" : "disabled"}>Assign</button>
        <button class="btn secondary" data-refresh>Yenilə</button>
      </div>
      ${selectedDriver ? `<div class="small" style="margin-top:8px">Seçilmiş sürücü: #${selectedDriver.user_id}</div>`:""}
    `;
    div.querySelector("[data-refresh]").onclick = refreshAll;
    div.querySelector("[data-assign]").onclick = async ()=>{
      if (!selectedDriver) return App.toast("Əvvəl sürücü seçin");
      await App.api("/admin/assign", { method:"POST", body:{ ride_id: r.id, driver_user_id: selectedDriver.user_id }});
      App.toast("Assign edildi");
      refreshAll();
    };
    box.appendChild(div);
  });
}

async function refreshAll(){
  const stats = await App.api("/admin/stats");
  renderStats(stats);

  const d = await App.api("/drivers/online");
  drivers = d.drivers || [];
  renderDrivers();

  const rr = await App.api("/rides/mine?limit=50");
  rides = rr.rides || [];
  renderRides();
}

const sock = io();
sock.emit("auth", { initData: App.getInitData(), role:"admin" });
sock.on("ride_created", ()=> refreshAll());
sock.on("ride_update", ()=> refreshAll());
sock.on("driver_online_change", ()=> refreshAll());
sock.on("driver_location", ()=> {/* could show map later */});

async function main(){
  await loadMe();
  await refreshAll();
}

main().catch(e=>{
  console.error(e);
  if (e.message !== "initData_missing_dev") App.toast("Xəta: " + e.message);
});
