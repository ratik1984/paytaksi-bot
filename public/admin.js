/* global Telegram, L */
const tg = window.Telegram?.WebApp;
if (tg) { tg.expand(); tg.ready(); }

function initData(){ const u=new URL(location.href); if(u.searchParams.get("dev")==="1") return ""; return tg?.initData||""; }
async function api(path,{method="GET",body=null}={}) {
  const headers={"Content-Type":"application/json"}; const d=initData(); if(d) headers["X-Telegram-Init-Data"]=d;
  const r=await fetch(path,{method,headers,body:body?JSON.stringify(body):null});
  const j=await r.json().catch(()=>({ok:false}));
  if(!j.ok) throw new Error(j.error||j.reason||"API_ERROR");
  return j;
}
const el=id=>document.getElementById(id);
const tabDash=el("tabDash"), tabUsers=el("tabUsers"), tabOrders=el("tabOrders"), tabDrivers=el("tabDrivers");
const pDash=el("pDash"), pUsers=el("pUsers"), pOrders=el("pOrders"), pDrivers=el("pDrivers");

function setTab(btn){
  for(const [b,p] of [[tabDash,pDash],[tabUsers,pUsers],[tabOrders,pOrders],[tabDrivers,pDrivers]]){ b.classList.toggle("active",b===btn); p.style.display=b===btn?"":"none"; }
}
tabDash.onclick=()=>setTab(tabDash); tabUsers.onclick=()=>setTab(tabUsers); tabOrders.onclick=()=>setTab(tabOrders); tabDrivers.onclick=()=>setTab(tabDrivers);

let map, markers={};
function initMap(){
  map=L.map("adminMap");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
  map.setView([40.4093,49.8671], 12);
}
function setMarker(id, lat, lon, label){
  const pos=[lat,lon];
  if(!markers[id]) markers[id]=L.marker(pos).addTo(map);
  markers[id].setLatLng(pos).bindPopup(label);
}

async function refresh(){
  const data=await api("/api/admin/overview");
  const counts=el("counts"); counts.innerHTML="";
  Object.entries(data.counts).forEach(([k,v])=>{
    const box=document.createElement("div"); box.className="item";
    box.innerHTML=`<div class="small">${k}</div><div style="font-size:20px;font-weight:800">${v}</div>`;
    counts.appendChild(box);
  });

  // users
  const usersList=el("usersList"); usersList.innerHTML="";
  data.users.forEach(u=>{
    const div=document.createElement("div"); div.className="item";
    const rate=u.ratingCount?`${u.ratingAvg} (${u.ratingCount})`:"—";
    div.innerHTML=`<div class="row" style="justify-content:space-between"><b>${u.name}</b>
      <span class="status"><span class="dot ${u.banned?"bad":"good"}"></span>${u.banned?"BANNED":"OK"}</span></div>
      <div class="small">ID: ${u.id} • role: ${u.role} • rating: ${rate}</div>
      <div class="row" style="margin-top:8px"><button class="btn ${u.banned?"good":"bad"}">${u.banned?"Unban":"Ban"}</button></div>`;
    div.querySelector("button").onclick=async ()=>{ await api("/api/admin/ban",{method:"POST",body:{userId:u.id,banned:!u.banned}}); await refresh(); };
    usersList.appendChild(div);
  });

  // orders
  const ordersList=el("ordersList"); ordersList.innerHTML="";
  data.orders.forEach(o=>{
    const div=document.createElement("div"); div.className="item";
    div.innerHTML=`<div class="row" style="justify-content:space-between"><b>#${o.id}</b>
      <span class="status"><span class="dot ${o.status==="completed"?"good":(o.status==="cancelled"?"bad":"warn")}"></span>${o.status}</span></div>
      <div class="small">${new Date(o.createdAt).toLocaleString()} • pay: ${o.payMethod}</div>
      <div class="small">Passenger: ${o.passengerId} • Driver: ${o.driverId||"—"}</div>
      <div class="small">Pick: ${o.pickup.addr}</div><div class="small">Drop: ${o.dropoff.addr}</div>`;
    ordersList.appendChild(div);
  });

  // drivers + map
  const now=Date.now();
  const driversList=el("driversList"); driversList.innerHTML="";
  data.drivers.forEach(d=>{
    const div=document.createElement("div"); div.className="item";
    const fresh=d.lastLocation && (now-d.lastLocation.ts)<60000;
    div.innerHTML=`<div class="row" style="justify-content:space-between"><b>${d.user?.name||("Driver "+d.id)}</b>
      <span class="status"><span class="dot ${d.online?"good":"bad"}"></span>${d.online?"Online":"Offline"}</span></div>
      <div class="small">ID: ${d.id} • activeOrder: ${d.activeOrderId||"—"}</div>
      <div class="small">Location: ${fresh?(d.lastLocation.lat.toFixed(5)+", "+d.lastLocation.lon.toFixed(5)):"—"}</div>`;
    driversList.appendChild(div);
    if(d.online && fresh) setMarker(d.id, d.lastLocation.lat, d.lastLocation.lon, `🚗 ${d.user?.name||d.id}`);
  });
}

initMap();
refresh();
setInterval(refresh, 5000);
