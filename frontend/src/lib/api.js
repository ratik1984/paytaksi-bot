export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

export function getToken() {
  return localStorage.getItem('paytaksi_token');
}

export function setToken(t) {
  if (!t) localStorage.removeItem('paytaksi_token');
  else localStorage.setItem('paytaksi_token', t);
}

export async function api(path, { method='GET', body, auth=true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function apiForm(path, formData, { method='POST' } = {}) {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`${API_BASE}${path}`, { method, headers, body: formData });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
