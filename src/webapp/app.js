(function(){
  const tg = window.Telegram?.WebApp;
  const qs = new URLSearchParams(location.search);
  const role = qs.get('role') || 'passenger';
  const rideIdFromUrl = Number(qs.get('ride_id') || 0);

  const rolePill = document.getElementById('rolePill');
  rolePill.textContent = role;

  const dbg = (t)=> document.getElementById('dbg').textContent = t;

  const passengerBox = document.getElementById('passengerBox');
  const driverBox = document.getElementById('driverBox');
  const ridesBox = document.getElementById('ridesBox');
  const chatBox = document.getElementById('chatBox');

  const fromTitle = document.getElementById('fromTitle');
  const fromLat = document.getElementById('fromLat');
  const fromLng = document.getElementById('fromLng');
  const toTitle = document.getElementById('toTitle');
  const toLat = document.getElementById('toLat');
  const toLng = document.getElementById('toLng');

  const createInfo = document.getElementById('createInfo');

  function getTgId(){
    const id = tg?.initDataUnsafe?.user?.id;
    return id ? Number(id) : 0;
  }

  // If opened outside telegram, allow manual tg id for testing
  const tgId = getTgId();
  dbg(tgId ? 'tg ok' : 'Local dev mode');

  function setGps(){
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos)=>{
      const { latitude, longitude } = pos.coords;
      fromLat.value = latitude.toFixed(6);
      fromLng.value = longitude.toFixed(6);
      if (!fromTitle.value) fromTitle.value = 'Mövcud yer';
    }, ()=>{}, { enableHighAccuracy:true, timeout:7000 });
  }

  async function api(path, opts){
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type':'application/json' },
      ...opts
    });
    const data = await res.json().catch(()=>({ok:false,error:'bad_json'}));
    if (!res.ok) throw data;
    return data;
  }

  async function refreshRides(){
    const list = document.getElementById('ridesList');
    list.innerHTML = '';
    if (!tgId) { list.innerHTML = '<div class="item">Telegram initData yoxdur (Local dev mode)</div>'; return; }
    const data = await api(`/ride/list?passenger_tg=${tgId}`, { method:'GET' });
    for (const it of data.items){
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div><b>#${it.id}</b> • ${it.status}</div>
        <div>${it.from_title} → ${it.to_title}</div>
        <div class="muted">Məsafə: ${Number(it.distance_km).toFixed(2)} km • Qiymət: ${Number(it.price_azn).toFixed(2)} AZN</div>
        <div class="muted">Sürücü: ${it.driver_tg ? it.driver_tg : '—'}</div>
      `;
      // cancel button only if active
      if (['searching','accepted','in_progress'].includes(it.status)){
        const btn = document.createElement('button');
        btn.textContent = 'Sifarişi ləğv et';
        btn.className = 'danger';
        btn.onclick = async ()=>{
          try{
            await api('/ride/cancel', { method:'POST', body: JSON.stringify({ passenger_tg: tgId, ride_id: it.id })});
            await refreshRides();
          }catch(e){
            alert('Xəta: ' + (e.error||''));
          }
        };
        div.appendChild(btn);

        // open chat if accepted
        if (it.status === 'accepted' && it.driver_tg){
          const cbtn = document.createElement('button');
          cbtn.textContent = 'Chat aç';
          cbtn.className = 'btn2';
          cbtn.onclick = ()=> openChat(it.id);
          div.appendChild(cbtn);
        }
      }
      list.appendChild(div);
    }
  }

  async function refreshSearching(){
    const list = document.getElementById('searchingList');
    list.innerHTML = '';
    const data = await api('/ride/searching', { method:'GET' });
    for (const it of data.items){
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div><b>#${it.id}</b> • ${it.status}</div>
        <div>${it.from_title} → ${it.to_title}</div>
        <div class="muted">Məsafə: ${Number(it.distance_km).toFixed(2)} km • Qiymət: ${Number(it.price_azn).toFixed(2)} AZN</div>
      `;
      const btn = document.createElement('button');
      btn.textContent = 'Qəbul et';
      btn.onclick = async ()=>{
        try{
          if (!tgId) return alert('Telegram initData yoxdur');
          await api('/ride/accept', { method:'POST', body: JSON.stringify({ driver_tg: tgId, ride_id: it.id })});
          await refreshSearching();
        }catch(e){
          alert('Xəta: ' + (e.error||''));
        }
      };
      div.appendChild(btn);

      const cbtn = document.createElement('button');
      cbtn.textContent = 'Chat';
      cbtn.className = 'btn2';
      cbtn.onclick = ()=> openChat(it.id);
      div.appendChild(cbtn);

      list.appendChild(div);
    }
  }

  async function createRide(){
    if (!tgId) return alert('Telegram initData yoxdur');
    try{
      createInfo.textContent = '';
      const payload = {
        passenger_tg: tgId,
        from: { title: fromTitle.value.trim(), lat: Number(fromLat.value)||null, lng: Number(fromLng.value)||null },
        to: { title: toTitle.value.trim(), lat: Number(toLat.value)||null, lng: Number(toLng.value)||null }
      };
      const data = await api('/ride/create', { method:'POST', body: JSON.stringify(payload) });
      createInfo.textContent = `Sifariş #${data.ride.id} yaradıldı. Təxmini qiymət: ${Number(data.ride.price_azn).toFixed(2)} AZN (komissiya: ${Number(data.ride.commission_azn).toFixed(2)} AZN)`;
      await refreshRides();
    }catch(e){
      if (e.error === 'active_ride_exists'){
        alert(`Sizdə aktiv sifariş var (#${e.ride_id}). Əvvəl ləğv edin və ya tamamlanmasını gözləyin.`);
      } else {
        alert('Xəta: ' + (e.error||''));
      }
    }
  }

  async function openChat(rideId){
    chatBox.style.display = 'block';
    chatBox.dataset.rideId = String(rideId);
    await loadChat();
  }

  async function loadChat(){
    const rideId = Number(chatBox.dataset.rideId || 0);
    if (!rideId) return;
    const list = document.getElementById('chatList');
    const data = await api(`/chat/list?ride_id=${rideId}`, { method:'GET' });
    list.innerHTML = '';
    for (const m of data.items){
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `<div><b>${m.sender_role}</b>: ${escapeHtml(m.message)}</div><div class="muted">${new Date(m.created_at).toLocaleString()}</div>`;
      list.appendChild(div);
    }
    list.scrollTop = list.scrollHeight;
  }

  async function sendChat(){
    const rideId = Number(chatBox.dataset.rideId || 0);
    if (!rideId) return alert('Ride seçilməyib');
    const msg = document.getElementById('chatMsg').value.trim();
    if (!msg) return;
    const sender_role = role === 'driver' ? 'driver' : 'passenger';
    await api('/chat/send', { method:'POST', body: JSON.stringify({ ride_id: rideId, sender_role, sender_tg: tgId, message: msg })});
    document.getElementById('chatMsg').value = '';
    await loadChat();
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s]));
  }

  // role views
  if (role === 'passenger') passengerBox.style.display = 'block';
  if (role === 'driver') driverBox.style.display = 'block';

  document.getElementById('createRideBtn')?.addEventListener('click', createRide);
  document.getElementById('refreshRides')?.addEventListener('click', refreshRides);
  document.getElementById('refreshSearching')?.addEventListener('click', refreshSearching);
  document.getElementById('sendChat')?.addEventListener('click', sendChat);

  // open chat if ride_id passed
  if (rideIdFromUrl) openChat(rideIdFromUrl);

  // auto
  setGps();
  refreshRides().catch(()=>{});
  if (role === 'driver') refreshSearching().catch(()=>{});
})();
