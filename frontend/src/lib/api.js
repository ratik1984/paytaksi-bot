const BASE = import.meta.env.VITE_API_BASE || "";

export function getToken() {
  return localStorage.getItem("pt_token") || "";
}

export function setToken(t) {
  if (t) localStorage.setItem("pt_token", t);
}

export function clearToken() {
  localStorage.removeItem("pt_token");
  localStorage.removeItem("pt_role");
}

export async function api(path, { method="GET", body=null, token=null, headers={} } = {}) {
  const h = { ...headers };
  if (token) h["Authorization"] = "Bearer " + token;
  if (body && !(body instanceof FormData)) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body });
  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!res.ok) throw Object.assign(new Error("API error"), { status: res.status, data });
  return data;
}
