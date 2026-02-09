// Shared helpers for Passenger/Driver/Admin PWA
export const App = (() => {
  const isTg = !!window.Telegram?.WebApp;
  const tg = window.Telegram?.WebApp;

  function getInitData() {
    if (isTg) return tg.initData || "";
    return localStorage.getItem("DEV_INIT_DATA") || "";
  }

  function setDevInitData(v) {
    localStorage.setItem("DEV_INIT_DATA", v);
  }

  function roleFromPath() {
    if (location.pathname.startsWith("/d/")) return "driver";
    if (location.pathname.startsWith("/admin/")) return "admin";
    return "passenger";
  }

  async function api(path, { method="GET", body=null } = {}) {
    const initData = getInitData();
    const role = roleFromPath();
    const headers = { "Content-Type":"application/json", "x-init-data": initData, "x-role": role };
    const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : null });
    const data = await res.json().catch(()=> ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `HTTP_${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function toast(msg, ms=2500) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(()=>el.classList.add("show"), 10);
    setTimeout(()=>{ el.classList.remove("show"); setTimeout(()=>el.remove(), 300); }, ms);
  }

  function haptics(type="impact") {
    try { if (isTg && tg.HapticFeedback) {
      if (type==="success") tg.HapticFeedback.notificationOccurred("success");
      else if (type==="error") tg.HapticFeedback.notificationOccurred("error");
      else tg.HapticFeedback.impactOccurred("medium");
    }} catch {}
  }

  function openExternal(url){
    if (isTg) tg.openLink(url);
    else window.open(url, "_blank");
  }

  function requireInitDataUI(container) {
    if (getInitData()) return;
    container.innerHTML = `
      <div class="card">
        <h2>DEV Mode</h2>
        <p>Telegram-dan kənarda açılıb. Test üçün initData lazımdır.</p>
        <textarea id="devInit" placeholder="Telegram WebApp initData buraya yapışdırın"></textarea>
        <button class="btn" id="saveInit">Yadda saxla</button>
      </div>
    `;
    container.querySelector("#saveInit").onclick = () => {
      const v = container.querySelector("#devInit").value.trim();
      if (!v) return toast("initData boşdur");
      setDevInitData(v);
      toast("Saxlanıldı. Səhifəni yenilə.");
    };
    throw new Error("initData_missing_dev");
  }

  function fmtTs(ts){
    if (!ts) return "";
    const d = new Date(ts*1000);
    return d.toLocaleString();
  }

  function distanceKm(a,b){
    const R=6371;
    const toRad = x=>x*Math.PI/180;
    const dLat=toRad(b.lat-a.lat);
    const dLon=toRad(b.lng-a.lng);
    const lat1=toRad(a.lat), lat2=toRad(b.lat);
    const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }

  return { isTg, tg, api, toast, haptics, openExternal, requireInitDataUI, fmtTs, distanceKm, getInitData };
})();
