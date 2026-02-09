// Passenger app logic
let map, pickupMarker, dropoffMarker;
let pickup = null, dropoff = null;
let lastOrderId = null;

function setStatus(){
  $('st_pickup').textContent = pickup ? `${pickup.lat.toFixed(5)}, ${pickup.lng.toFixed(5)}` : '-';
  $('st_dropoff').textContent = dropoff ? `${dropoff.lat.toFixed(5)}, ${dropoff.lng.toFixed(5)}` : '-';
}

function setMarker(which, latlng){
  if(which === 'pickup'){
    pickup = { lat: latlng.lat, lng: latlng.lng, address: $('pickup').value || '' };
    if(!pickupMarker) pickupMarker = L.marker(latlng, { draggable:true }).addTo(map);
    pickupMarker.setLatLng(latlng);
    pickupMarker.on('dragend', async (e)=>{
      const p = e.target.getLatLng();
      pickup.lat=p.lat; pickup.lng=p.lng;
      const rev = await nominatimReverse(p.lat,p.lng);
      if (rev?.display_name) $('pickup').value = rev.display_name;
      setStatus();
    });
  } else {
    dropoff = { lat: latlng.lat, lng: latlng.lng, address: $('dropoff').value || '' };
    if(!dropoffMarker) dropoffMarker = L.marker(latlng, { draggable:true }).addTo(map);
    dropoffMarker.setLatLng(latlng);
    dropoffMarker.on('dragend', async (e)=>{
      const p = e.target.getLatLng();
      dropoff.lat=p.lat; dropoff.lng=p.lng;
      const rev = await nominatimReverse(p.lat,p.lng);
      if (rev?.display_name) $('dropoff').value = rev.display_name;
      setStatus();
    });
  }
  setStatus();
}

async function setFromText(which, text){
  if(!text || text.trim().length < 3) return;
  const res = await nominatimSearch(text);
  if(!res.length) return;
  const best = res[0];
  const lat = parseFloat(best.lat), lng = parseFloat(best.lon);
  if(which==='pickup') $('pickup').value = best.display_name;
  if(which==='dropoff') $('dropoff').value = best.display_name;
  map.setView([lat,lng], 14);
  setMarker(which, {lat, lng});
}

function wireSuggest(inputId, boxId, which){
  const input = $(inputId);
  const box = $(boxId);

  const render = (items)=>{
    box.innerHTML = '';
    if(!items.length){ box.style.display='none'; return; }
    for(const it of items){
      const d = document.createElement('div');
      d.className='suggestItem';
      d.textContent = it.display_name;
      d.onclick = ()=>{
        input.value = it.display_name;
        box.style.display='none';
        const lat=parseFloat(it.lat), lng=parseFloat(it.lon);
        map.setView([lat,lng], 15);
        setMarker(which, {lat,lng});
      };
      box.appendChild(d);
    }
    box.style.display='block';
  };

  const doSearch = debounce(async ()=>{
    const q = input.value.trim();
    if(q.length<3){ box.style.display='none'; return; }
    try{ render(await nominatimSearch(q)); }catch(e){ box.style.display='none'; }
  }, 250);

  input.addEventListener('input', doSearch);
  input.addEventListener('focus', doSearch);
  document.addEventListener('click', (e)=>{
    if(!box.contains(e.target) && e.target !== input) box.style.display='none';
  });
}

async function myLocation(){
  toast('Yeriniz alınır...');
  if(!navigator.geolocation){ toast('Geolocation dəstəklənmir'); return; }
  navigator.geolocation.getCurrentPosition(async (pos)=>{
    const lat=pos.coords.latitude, lng=pos.coords.longitude;
    map.setView([lat,lng], 15);
    setMarker('pickup', {lat,lng});
    const rev = await nominatimReverse(lat,lng);
    if (rev?.display_name) $('pickup').value = rev.display_name;
    toast('Pickup seçildi');
  }, ()=>{
    toast('Yer icazəsi verilmədi');
  }, { enableHighAccuracy:true, timeout:10000 });
}

async function orderNow(){
  const u = tgUser();
  if(!u){ toast('Telegram user tapılmadı'); return; }

  // ensure coords from text if needed
  if(!pickup) await setFromText('pickup', $('pickup').value);
  if(!dropoff) await setFromText('dropoff', $('dropoff').value);

  if(!pickup || !dropoff){
    toast('Pickup və Dropoff seçin');
    return;
  }

  try{
    const res = await API.post('/api/order/create', {
      passenger: u,
      pickup: { ...pickup, address: $('pickup').value },
      dropoff: { ...dropoff, address: $('dropoff').value },
      note: $('note').value || ''
    });
    lastOrderId = res.order_id;
    toast('Sifariş yaradıldı. Sürücü gözlənilir...');
    $('order_id').textContent = lastOrderId;
    pollStatus();
  }catch(e){
    toast('Xəta: ' + (e.message || ''));
  }
}

async function pollStatus(){
  if(!lastOrderId) return;
  try{
    const st = await API.get('/api/order/status?order_id=' + encodeURIComponent(lastOrderId));
    $('order_state').textContent = st.status;
    $('driver_name').textContent = st.driver ? (st.driver.first_name + (st.driver.username?(' (@'+st.driver.username+')'):'') ) : '-';
    if(st.status === 'accepted'){
      toast('Sürücü sifarişi qəbul etdi');
      return; // stop polling
    }
  }catch(e){}
  setTimeout(pollStatus, 2500);
}

function initMap(){
  map = L.map('map', { zoomControl:false }).setView([40.4093, 49.8671], 12); // Baku
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  L.control.zoom({ position:'bottomright' }).addTo(map);

  let tapStep = 0;
  map.on('click', async (e)=>{
    tapStep++;
    if(tapStep % 2 === 1){
      setMarker('pickup', e.latlng);
      const rev = await nominatimReverse(e.latlng.lat, e.latlng.lng);
      if (rev?.display_name) $('pickup').value = rev.display_name;
      toast('Pickup seçildi');
    }else{
      setMarker('dropoff', e.latlng);
      const rev = await nominatimReverse(e.latlng.lat, e.latlng.lng);
      if (rev?.display_name) $('dropoff').value = rev.display_name;
      toast('Dropoff seçildi');
    }
  });
  setStatus();
}

window.addEventListener('DOMContentLoaded', ()=>{
  initMap();
  wireSuggest('pickup','pickupSuggest','pickup');
  wireSuggest('dropoff','dropoffSuggest','dropoff');
  $('btn_loc').onclick = myLocation;
  $('btn_order').onclick = orderNow;
});
