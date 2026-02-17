/* global Telegram */

function qs(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function getTgId() {
  // MVP: use query param
  const id = qs('tg_id');
  return id ? Number(id) : null;
}

function apiBase() {
  return '';
}

async function apiGet(path) {
  const r = await fetch(apiBase() + path);
  if (!r.ok) throw new Error('API error');
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(apiBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'API error');
  return data;
}

function connectSocket() {
  const socket = io();
  return socket;
}

function setStatus(el, text) {
  el.textContent = text;
}

function money(n) {
  return (Number(n || 0)).toFixed(2);
}
