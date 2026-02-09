export function now() { return Math.floor(Date.now() / 1000); }

export function uid(prefix="r") {
  return `${prefix}_${Math.random().toString(36).slice(2,10)}${Math.random().toString(36).slice(2,10)}`;
}

export function parseJsonSafe(s, fallback={}) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
