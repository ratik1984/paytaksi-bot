/* global Telegram, L */
const tg = window.Telegram?.WebApp;
if (tg) { tg.expand(); tg.ready(); }

function initData() {
  const u = new URL(location.href);
  if (u.searchParams.get("dev")==="1") return "";
  return tg?.initData || "";
}

async function api(path, {method="GET", body=null}={}) {
  const headers = {"Content-Type":"application/json"};
  const d = initData();
  if (d) headers["X-Telegram-Init-Data"] = d;
  const r = await fetch(path, {method, headers, body: body?JSON.stringify(body):null});
  const j = await r.json().catch(()=>({ok:false}));
  if (!j.ok) throw new Error(j.error || j.reason || "API_ERROR");
  return j;
}

const el=id=>document.getElementById(id);
const tabPassenger=el("tabPassenger"), tabDriver=el("tabDriver"), tabHistory=el("tabHistory");
const panelPassenger=el("panelPassenger"), panelDriver=el("panelDriver"), panelHistory=el("panelHistory");
const roleBadge=el("roleBadge");

function setTab(btn){
  for (const [b,p] of [[tabPassenger,panelPassenger],[tabDriver,panelDriver],[tabHistory,panelHistory]]) {
    b.classList.toggle("active", b===btn);
    p.style.display = b===btn ? "" : "none";
  }
}
tabPassenger.onclick=()=>setTab(tabPassenger);
tabDriver.onclick=()=>setTab(tabDriver);
tabHistory.onclick=()=>setTab(tabHistory);

let map, myMarker, pickupMarker, dropoffMarker, taxiMarker;
let pickup=null, dropoff=null;
let currentOrder=null;
let trackTimer=null;

function initMap(){
  map = L.map("map");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
  map.setView([40.4093,49.8671], 12);
}
function setMarker(kind, lat, lon, label){
  const pos=[lat,lon];
  const mk = (ref)=>{
    if(!ref) return L.marker(pos).addTo(map);
    ref.setLatLng(pos);
    return ref;
  };
  if(kind==="me"){ myMarker = mk(myMarker); myMarker.bindPopup(label||"Mən").openPopup(); }
  if(kind==="pickup"){ pickupMarker = mk(pickupMarker); pickupMarker.bindPopup("Pick"); }
  if(kind==="dropoff"){ dropoffMarker = mk(dropoffMarker); dropoffMarker.bindPopup("Drop"); }
  if(kind==="taxi"){ taxiMarker = mk(taxiMarker); taxiMarker.bindPopup("🚕 Taksi"); }
  map.panTo(pos);
}
function dotState(dot, state){
  dot.classList.remove("good","warn","bad");
  dot.classList.add(state==="good"?"good":(state==="bad"?"bad":"warn"));
}
async function gps(){
  return new Promise((resolve,reject)=>{
    navigator.geolocation.getCurrentPosition(
      p=>resolve({lat:p.coords.latitude, lon:p.coords.longitude}),
      e=>reject(e),
      {enableHighAccuracy:true, timeout:10000}
    );
  });
}

// address search
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
async function geocode(q){ return api(`/api/geocode?q=${encodeURIComponent(q)}`); }
function showSug(box, items, onPick){
  box.innerHTML="";
  if(!items.length){ box.style.display="none"; return; }
  items.forEach(it=>{
    const b=document.createElement("button");
    b.textContent=it.display_name;
    b.onclick=()=>{ box.style.display="none"; onPick(it); };
    box.appendChild(b);
  });
  box.style.display="";
}

const pickupInput=el("pickupInput"), dropoffInput=el("dropoffInput");
const pickupSug=el("pickupSug"), dropoffSug=el("dropoffSug");

pickupInput.addEventListener("input", debounce(async ()=>{
  const q=pickupInput.value.trim();
  if(q.length<3) return pickupSug.style.display="none";
  try{
    const r=await geocode(q);
    showSug(pickupSug, r.items, it=>{
      pickup={lat:it.lat, lon:it.lon, addr:it.display_name};
      pickupInput.value=it.display_name;
      setMarker("pickup", it.lat, it.lon);
    });
  }catch{ pickupSug.style.display="none"; }
}, 350));

dropoffInput.addEventListener("input", debounce(async ()=>{
  const q=dropoffInput.value.trim();
  if(q.length<3) return dropoffSug.style.display="none";
  try{
    const r=await geocode(q);
    showSug(dropoffSug, r.items, it=>{
      dropoff={lat:it.lat, lon:it.lon, addr:it.display_name};
      dropoffInput.value=it.display_name;
      setMarker("dropoff", it.lat, it.lon);
    });
  }catch{ dropoffSug.style.display="none"; }
}, 350));

el("btnMyLocation").onclick = async ()=>{
  try{
    const loc=await gps();
    setMarker("me", loc.lat, loc.lon, "Mənim yerim");
    if(!pickup){
      pickup={lat:loc.lat, lon:loc.lon, addr:"Mənim yerim (GPS)"};
      pickupInput.value=pickup.addr;
      setMarker("pickup", loc.lat, loc.lon);
    }
  }catch{ alert("GPS icazəsi ver."); }
};

// order UI + tracking
const orderDot=el("orderDot"), orderStatus=el("orderStatus"), orderInfo=el("orderInfo");
const wazeLink=el("wazeLink"), btnRate=el("btnRate");
function updateOrderUI(order, driver){
  currentOrder=order||null;
  if(!order){
    dotState(orderDot,"warn");
    orderStatus.textContent="Sifariş yoxdur";
    orderInfo.textContent="—";
    wazeLink.style.display="none";
    btnRate.style.display="none";
    return;
  }
  const m={searching:"Sürücü axtarılır…",assigned:"Sifariş gəldi (zəng)…",accepted:"Qəbul edildi ✅",arrived:"Sürücü gəldi 📍",in_trip:"Yoldasınız 🚕",completed:"Tamamlandı ✅",cancelled:"Ləğv edildi ❌"};
  orderStatus.textContent=m[order.status]||order.status;
  dotState(orderDot, order.status==="completed"?"good":(order.status==="cancelled"?"bad":"warn"));
  orderInfo.textContent=`Ödəniş: ${order.payMethod==="card"?"Kart":"Nəğd"} • Pick: ${order.pickup.addr} • Drop: ${order.dropoff.addr}`;
  if(driver?.lastLocation) setMarker("taxi", driver.lastLocation.lat, driver.lastLocation.lon);
  btnRate.style.display = (order.status==="completed" && !order.rating) ? "" : "none";
  if(order.dropoff?.lat && order.dropoff?.lon){
    wazeLink.href = `https://waze.com/ul?ll=${order.dropoff.lat}%2C${order.dropoff.lon}&navigate=yes`;
    wazeLink.style.display="";
  }
}
function startTracking(orderId){
  clearInterval(trackTimer);
  trackTimer=setInterval(async ()=>{
    try{
      const t=await api(`/api/order/${orderId}/track`);
      updateOrderUI(t.order, t.driver);
      if(["completed","cancelled"].includes(t.order.status)) clearInterval(trackTimer);
    }catch{ clearInterval(trackTimer); }
  }, 3000);
}

el("btnOrder").onclick = async ()=>{
  if(!pickup||!dropoff) return alert("Pick və Drop seç.");
  try{
    const payMethod=el("payMethod").value;
    const r=await api("/api/passenger/create_order",{method:"POST",body:{pickup,dropoff,payMethod}});
    updateOrderUI(r.order, null);
    startTracking(r.order.id);
    await refreshHistory();
  }catch(e){ alert("Sifariş xətası: "+e.message); }
};

// rating
const rateModal=el("rateModal"), rateClose=el("rateClose");
btnRate.onclick=()=>rateModal.classList.add("show");
rateClose.onclick=()=>rateModal.classList.remove("show");
rateModal.addEventListener("click",(e)=>{ if(e.target===rateModal) rateModal.classList.remove("show"); });
rateModal.querySelectorAll("button[data-rate]").forEach(b=>{
  b.onclick=async ()=>{
    try{
      const r=Number(b.dataset.rate);
      await api("/api/passenger/rate",{method:"POST",body:{orderId:currentOrder.id,rating:r}});
      rateModal.classList.remove("show");
      const t=await api(`/api/order/${currentOrder.id}/track`);
      updateOrderUI(t.order, t.driver);
      await refreshHistory();
    }catch(e){ alert("Reytinq xətası: "+e.message); }
  };
});

// history
async function refreshHistory(){
  try{
    const r=await api("/api/passenger/history");
    const list=el("historyList");
    list.innerHTML="";
    r.orders.forEach(o=>{
      const div=document.createElement("div");
      div.className="item";
      div.innerHTML=`<div class="row" style="justify-content:space-between"><b>#${o.id}</b>
        <span class="status"><span class="dot ${o.status==="completed"?"good":(o.status==="cancelled"?"bad":"warn")}"></span>${o.status}</span></div>
        <div class="small">${new Date(o.createdAt).toLocaleString()}</div>
        <div class="small">Pick: ${o.pickup.addr}</div>
        <div class="small">Drop: ${o.dropoff.addr}</div>`;
      div.onclick=async ()=>{
        const t=await api(`/api/order/${o.id}/track`);
        updateOrderUI(t.order,t.driver);
        setMarker("pickup", t.order.pickup.lat, t.order.pickup.lon);
        setMarker("dropoff", t.order.dropoff.lat, t.order.dropoff.lon);
        setTab(tabPassenger);
        startTracking(o.id);
      };
      list.appendChild(div);
    });
  }catch{}
}

// driver side
let isOnline=false, driverTimer=null, incomingTimer=null, activeDriverOrder=null, incomingOrder=null;

const drvDot=el("drvDot"), drvStatus=el("drvStatus"), btnToggleOnline=el("btnToggleOnline"), drvOrderInfo=el("drvOrderInfo");
const btnArrived=el("btnArrived"), btnInTrip=el("btnInTrip"), btnComplete=el("btnComplete"), btnDrvCancel=el("btnDrvCancel");

function updateDriverUI(){
  dotState(drvDot, isOnline?"good":"bad");
  drvStatus.textContent=isOnline?"Online":"Offline";
  btnToggleOnline.textContent=isOnline?"Offline ol":"Online ol";
  if(!activeDriverOrder){
    drvOrderInfo.textContent="—";
    [btnArrived,btnInTrip,btnComplete,btnDrvCancel].forEach(x=>x.style.display="none");
    return;
  }
  drvOrderInfo.innerHTML=`<b>#${activeDriverOrder.id}</b><div class="small">Pick: ${activeDriverOrder.pickup.addr}</div>
  <div class="small">Drop: ${activeDriverOrder.dropoff.addr}</div><div class="small">Status: ${activeDriverOrder.status}</div>`;
  btnArrived.style.display = activeDriverOrder.status==="accepted" ? "" : "none";
  btnInTrip.style.display = activeDriverOrder.status==="arrived" ? "" : "none";
  btnComplete.style.display = activeDriverOrder.status==="in_trip" ? "" : "none";
  btnDrvCancel.style.display = ["assigned","accepted","arrived","in_trip"].includes(activeDriverOrder.status) ? "" : "none";
}

btnToggleOnline.onclick=async ()=>{
  try{
    isOnline=!isOnline;
    await api("/api/driver/set_status",{method:"POST",body:{online:isOnline}});
    if(isOnline) startDriverLoops(); else stopDriverLoops();
    updateDriverUI();
  }catch(e){ alert("Sürücü xətası: "+e.message); }
};

async function sendDriverLoc(){
  try{
    const loc=await gps();
    await api("/api/driver/update_location",{method:"POST",body:{lat:loc.lat,lon:loc.lon}});
    setMarker("me", loc.lat, loc.lon, "Sürücü");
  }catch{}
}
async function checkDriverOrders(){
  try{
    const r=await api("/api/driver/pending");
    const assigned=r.orders.find(o=>o.status==="assigned");
    activeDriverOrder=r.orders[0]||null;
    updateDriverUI();
    if(assigned) showIncoming(assigned);
  }catch{}
}
function startDriverLoops(){
  stopDriverLoops();
  driverTimer=setInterval(sendDriverLoc, 3000);
  incomingTimer=setInterval(checkDriverOrders, 2500);
  sendDriverLoc(); checkDriverOrders();
}
function stopDriverLoops(){
  clearInterval(driverTimer); clearInterval(incomingTimer);
  driverTimer=null; incomingTimer=null;
}

// incoming call-like
const incomingModal=el("incomingModal"), incomingInfo=el("incomingInfo"), incomingAccept=el("incomingAccept"), incomingReject=el("incomingReject");
const ringtone=el("ringtone");
function showIncoming(order){
  if(incomingOrder && incomingOrder.id===order.id) return;
  incomingOrder=order;
  incomingInfo.innerHTML=`<b>#${order.id}</b><div class="small">Pick: ${order.pickup.addr}</div><div class="small">Drop: ${order.dropoff.addr}</div>`;
  incomingModal.classList.add("show");
  try{ ringtone.currentTime=0; ringtone.play(); }catch{}
}
function hideIncoming(){
  incomingModal.classList.remove("show");
  incomingOrder=null;
  try{ ringtone.pause(); }catch{}
}
incomingReject.onclick=()=>hideIncoming();
incomingAccept.onclick=async ()=>{
  if(!incomingOrder) return;
  try{
    await api("/api/driver/accept",{method:"POST",body:{orderId:incomingOrder.id}});
    hideIncoming();
    await checkDriverOrders();
  }catch(e){ alert("Qəbul xətası: "+e.message); }
};

async function setDriverStatus(status){
  if(!activeDriverOrder) return;
  try{
    const r=await api("/api/driver/status",{method:"POST",body:{orderId:activeDriverOrder.id,status}});
    activeDriverOrder=r.order;
    updateDriverUI();
  }catch(e){ alert("Status xətası: "+e.message); }
}
btnArrived.onclick=()=>setDriverStatus("arrived");
btnInTrip.onclick=()=>setDriverStatus("in_trip");
btnComplete.onclick=()=>setDriverStatus("completed");
btnDrvCancel.onclick=()=>setDriverStatus("cancelled");

// boot
initMap();
(async ()=>{
  try{
    const me=await api("/api/me");
    roleBadge.textContent = me.user?.role==="driver" ? "Sürücü" : "Sərnişin";
    if(me.user?.role==="driver") setTab(tabDriver);
  }catch{ roleBadge.textContent="Demo"; }
  await refreshHistory();
})();
