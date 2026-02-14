function tgInitData() {
  // Telegram injects initData. Fallback empty for local dev.
  return (window.Telegram && Telegram.WebApp && Telegram.WebApp.initData) ? Telegram.WebApp.initData : "";
}

function ptToken() {
  try {
    return new URLSearchParams(window.location.search).get('pt') || "";
  } catch {
    return "";
  }
}
function tgUser() {
  return (window.Telegram && Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.user) ? Telegram.WebApp.initDataUnsafe.user : null;
}
function setStatus(el, msg, ok=true){
  el.textContent = msg;
  el.style.color = ok ? '' : 'crimson';
}
async function api(path, {method='GET', body=null, headers={}}={}){
  const h = { 'Content-Type':'application/json', ...headers };
  if (tgInitData()) h['X-Tg-InitData'] = tgInitData();
  // If initData is empty on some clients, backend can auth with signed pt token
  if (!tgInitData() && ptToken()) h['X-Pt-Token'] = ptToken();
  // Unsafe fallback (dev only) - helps keep local dev mode working
  if (!tgInitData() && !ptToken() && tgUser()) h['X-Tg-Unsafe'] = JSON.stringify({ ...tgUser(), role: window.__ROLE__ });
  const res = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : null });
  const data = await res.json().catch(()=>({ok:false,error:'bad_json'}));
  if (!res.ok) throw Object.assign(new Error(data.error||'http_error'), { status: res.status, data });
  return data;
}

// ---- Telegram helpers
function openTelegramUser({ tg_id, username }) {
  const tg = window.Telegram && Telegram.WebApp ? Telegram.WebApp : null;
  // Prefer username link (more widely supported)
  if (username) {
    const url = `https://t.me/${String(username).replace(/^@/, '')}`;
    try {
      if (tg && tg.openTelegramLink) return tg.openTelegramLink(url);
      if (tg && tg.openLink) return tg.openLink(url);
    } catch {}
    window.open(url, '_blank');
    return;
  }

  // Fallback to tg://user?id=...
  if (tg_id) {
    const deep = `tg://user?id=${encodeURIComponent(String(tg_id))}`;
    try {
      if (tg && tg.openTelegramLink) return tg.openTelegramLink(deep);
      if (tg && tg.openLink) return tg.openLink(deep);
    } catch {}
    window.location.href = deep;
  }
}
