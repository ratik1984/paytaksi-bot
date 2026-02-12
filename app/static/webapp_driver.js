(function(){
  const tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
  if(tg){ tg.ready(); tg.expand(); }

  const $ = (id)=>document.getElementById(id);
  const st = $("status");
  const box = $("rides");

  async function api(path, payload){
    const initData = tg ? (tg.initData || "") : "";
    const res = await fetch(path, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(Object.assign({}, payload || {}, {initData}))
    });
    return await res.json();
  }

  function render(rides){
    if(!rides || rides.length===0){
      box.innerHTML = "<div class='muted'>Hazırda aktiv sifariş yoxdur.</div>";
      return;
    }
    box.innerHTML = rides.map(r => (
      `<div class='card'>`+
      `<div><b>Sifariş #${r.id}</b> — <span class='muted'>${r.status}</span></div>`+
      `<div class='muted'>Götürmə: ${escapeHtml(r.pickup_address||'')}</div>`+
      `<div class='muted'>Gedəcək: ${escapeHtml(r.dropoff_address||'')}</div>`+
      `<div><b>Qiymət:</b> ${r.fare} AZN</div>`+
      (r.status==='offered' ? `<button class='btn' data-ride='${r.id}'>Qəbul et</button>` : ``)+
      `</div>`
    )).join("");

    // bind accept
    document.querySelectorAll("button[data-ride]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const rid = btn.getAttribute("data-ride");
        btn.disabled = true;
        const resp = await api("/api/webapp/driver/accept_ride", {ride_id: rid});
        if(resp.ok){
          if(tg){ tg.showPopup({message: "Sifariş qəbul edildi."}); }
          refresh();
        } else {
          btn.disabled = false;
          if(tg){ tg.showPopup({message: resp.error || "Xəta"}); }
        }
      });
    });
  }

  function escapeHtml(s){
    return (s||"").replace(/[&<>"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }

  async function refresh(){
    st.textContent = "Yüklənir…";
    const data = await api("/api/webapp/driver/my_rides", {});
    if(!data.ok){
      st.textContent = data.error || "Xəta";
      return;
    }
    st.textContent = "Hazır";
    render(data.rides);
  }

  refresh();
})();
