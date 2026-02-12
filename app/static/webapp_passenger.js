(function(){
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if(tg){ tg.ready(); tg.expand(); }

  const $ = (id)=>document.getElementById(id);
  const st = $("status");
  const dest = $("dest");
  const sug = $("suggestions");
  const fareBox = $("fareBox");
  const fareVal = $("fareVal");
  const btnCreate = $("create");
  const useMy = $("useMy");

  let pickup = null; // {lat, lon}
  let destination = null; // {lat, lon, name}
  let lastSug = [];

  function setStatus(msg){ st.textContent = msg; }

  async function geoPickup(){
    setStatus("Lokasiya alınır...");
    return new Promise((resolve, reject)=>{
      if(tg && tg.location && tg.location.latitude){
        pickup = {lat: tg.location.latitude, lon: tg.location.longitude};
        setStatus("Lokasiya hazır: " + pickup.lat.toFixed(5)+", "+pickup.lon.toFixed(5));
        resolve(pickup);
        return;
      }
      if(!navigator.geolocation) return reject(new Error("Geolocation dəstəklənmir"));
      navigator.geolocation.getCurrentPosition((pos)=>{
        pickup = {lat: pos.coords.latitude, lon: pos.coords.longitude};
        setStatus("Lokasiya hazır: " + pickup.lat.toFixed(5)+", "+pickup.lon.toFixed(5));
        resolve(pickup);
      }, (err)=>reject(err), {enableHighAccuracy:true, timeout:15000});
    });
  }

  async function photonSearch(q){
    const url = "https://photon.komoot.io/api/?limit=6&lang=az&query=" + encodeURIComponent(q);
    const r = await fetch(url);
    const j = await r.json();
    return (j.features||[]).map(f=>{
      const p = f.properties||{};
      const name = [p.name, p.street, p.city, p.country].filter(Boolean).join(", ");
      const [lon, lat] = f.geometry.coordinates;
      return {name, lat, lon};
    }).filter(x=>x.name);
  }

  function renderSuggestions(list){
    sug.innerHTML = "";
    list.forEach((item, idx)=>{
      const div = document.createElement("div");
      div.className = "sug";
      div.textContent = item.name;
      div.onclick = ()=>{
        destination = item;
        dest.value = item.name;
        sug.innerHTML = "";
        updateFare();
      };
      sug.appendChild(div);
    });
  }

  function haversineKm(a,b){
    const R = 6371;
    const dLat = (b.lat-a.lat)*Math.PI/180;
    const dLon = (b.lon-a.lon)*Math.PI/180;
    const lat1 = a.lat*Math.PI/180;
    const lat2 = b.lat*Math.PI/180;
    const x = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    const c = 2*Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
    return R*c;
  }

  function calcFare(distanceKm){
    // Must match backend defaults (roughly)
    const base = 3.50;
    const included = 3.0;
    const perKm = 0.40;
    let fare = base;
    if(distanceKm > included) fare += (distanceKm-included)*perKm;
    return Math.round(fare*100)/100;
  }

  function updateFare(){
    if(!pickup || !destination) { fareBox.classList.add("hidden"); btnCreate.disabled = true; return; }
    const km = haversineKm(pickup, destination);
    const fare = calcFare(km);
    fareVal.textContent = `${fare.toFixed(2)} AZN (təxmini, ${km.toFixed(1)} km)`;
    fareBox.classList.remove("hidden");
    btnCreate.disabled = false;
  }

  let t = null;
  dest.addEventListener("input", ()=>{
    const q = dest.value.trim();
    destination = null;
    updateFare();
    if(t) clearTimeout(t);
    if(q.length < 3){ sug.innerHTML=""; return; }
    t = setTimeout(async ()=>{
      try{
        const list = await photonSearch(q);
        lastSug = list;
        renderSuggestions(list);
      }catch(e){
        console.error(e);
      }
    }, 250);
  });

  useMy.onclick = async ()=>{
    try{ await geoPickup(); updateFare(); }
    catch(e){ setStatus("Lokasiya alınmadı: "+ (e.message||e)); }
  };

  btnCreate.onclick = async ()=>{
    try{
      if(!pickup) await geoPickup();
      if(!destination){ setStatus("Gedəcəyin yeri seç"); return; }
      btnCreate.disabled = true;
      setStatus("Sifariş göndərilir...");
      const payload = {
        initData: tg ? tg.initData : "",
        pickup,
        destination,
      };
      const r = await fetch("/api/webapp/passenger/create_ride", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if(!r.ok){ throw new Error(j.detail || "Xəta"); }
      setStatus(`Sifariş yaradıldı: #${j.ride_id}. Sürücü axtarılır...`);
      if(tg){ tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("success"); }
    }catch(e){
      setStatus("Xəta: " + (e.message||e));
      btnCreate.disabled = false;
    }
  };

  // init
  setStatus("Başlamaq üçün 'Lokasiyamı götür' bas.");
})();
