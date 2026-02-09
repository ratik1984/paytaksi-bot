// Driver app logic
let map, meMarker, pickupMarker, dropoffMarker;
let online = false;
let lastOrders = [];

function driverId(){
  const u = tgUser();
  return u ? String(u.id) : null;
}

function renderOrders(list){
  const box = $('orders');
  box.innerHTML = '';
  if(!list.length){
    box.innerHTML = '<div class="small">Hazırda yeni sifariş yoxdur.</div>';
    return;
  }
  for(const o of list){
    const c = document.createElement('div');
    c.className='card';
    c.style.marginTop='10px';
    c.innerHTML = `
      <div class="kv"><span>Sifariş</span><b>${o.id}</b></div>
      <div class="hr"></div>
      <div class="small"><b>Pickup:</b> ${o.pickup.address || (o.pickup.lat.toFixed(5)+', '+o.pickup.lng.toFixed(5))}</div>
      <div class="small" style="margin-top:6px"><b>Dropoff:</b> ${o.dropoff.address || (o.dropoff.lat.toFixed(5)+', '+o.dropoff.lng.toFixed(5))}</div>
      <div class="hr"></div>
      <button class="btn primary" data-id="${o.id}">Qəbul et</button>
    `;
    c.querySelector('button').onclick = ()=>acceptOrder(o.id);
    box.appendChild(c);
  }
}

function setMarkers(o){
  if(!o) return;
  const p1 = {lat:o.pickup.lat, lng:o.pickup.lng};
  const p2 = {lat:o.dropoff.lat, lng:o.dropoff.lng};
  if(!pickupMarker) pickupMarker = L.marker(p1).addTo(map); else pickupMarker.setLatLng(p1);
  if(!dropoffMarker) dropoffMarker = L.marker(p2).addTo(map); else dropoffMarker.setLatLng(p2);
  const b = L.latLngBounds([p1.lat,p1.lng],[p2.lat,p2.lng]);
  map.fitBounds(b.pad(0.25));
}

async function myLocation(){
  if(!navigator.geolocation){ toast('Geolocation yoxdur'); return; }
  navigator.geolocation.getCurrentPosition((pos)=>{
    const lat=pos.coords.latitude, lng=pos.coords.longitude;
    if(!map){
      initMap(lat,lng);
    }else{
      map.setView([lat,lng], 15);
    }
    if(!meMarker) meMarker = L.marker({lat,lng}).addTo(map);
    else meMarker.setLatLng({lat,lng});
    $('me').textContent = lat.toFixed(5)+', '+lng.toFixed(5);
  }, ()=>toast('Yer icazəsi verilmədi'), {enableHighAccuracy:true, timeout:10000});
}

async function goOnline(){
  const u = tgUser();
  if(!u){ toast('Telegram user tapılmadı'); return; }
  await myLocation();
  const latlng = meMarker?.getLatLng();
  if(!latlng){ toast('Yer tapılmadı'); return; }
  const car = $('car').value.trim();
  const plate = $('plate').value.trim();
  try{
    await API.post('/api/driver/online', {
      driver: u,
      car, plate,
      lat: latlng.lat, lng: latlng.lng
    });
    online = true;
    $('state').textContent = 'online';
    toast('Online');
    pollOrders();
  }catch(e){
    toast('Xəta: ' + (e.message||''));
  }
}

async function goOffline(){
  const id = driverId();
  if(!id) return;
  try{
    await API.post('/api/driver/offline', { driver_id: id });
    online = false;
    $('state').textContent = 'offline';
    toast('Offline');
  }catch(e){}
}

async function pollOrders(){
  if(!online) return;
  const id = driverId();
  if(!id) return;
  try{
    const res = await API.get('/api/driver/orders?driver_id=' + encodeURIComponent(id));
    lastOrders = res.orders || [];
    renderOrders(lastOrders);
  }catch(e){}
  setTimeout(pollOrders, 2500);
}

async function acceptOrder(orderId){
  const id = driverId();
  if(!id) return;
  try{
    const res = await API.post('/api/driver/accept', { driver_id: id, order_id: orderId });
    toast('Qəbul edildi');
    $('accepted').textContent = orderId;
    setMarkers(res.order);
    pollOrders();
  }catch(e){
    toast('Xəta: ' + (e.message||''));
  }
}

function initMap(lat=40.4093, lng=49.8671){
  map = L.map('map', { zoomControl:false }).setView([lat,lng], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  L.control.zoom({ position:'bottomright' }).addTo(map);
}

window.addEventListener('DOMContentLoaded', ()=>{
  initMap();
  $('btn_loc').onclick = myLocation;
  $('btn_on').onclick = goOnline;
  $('btn_off').onclick = goOffline;
  myLocation();
});
