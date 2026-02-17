export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function money2(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return '0.00';
  return x.toFixed(2);
}

export function nowIso() {
  return new Date().toISOString();
}

export function azPhoneNormalize(input) {
  // Expected: +994XXXXXXXXX
  const s = (input || '').replace(/\s+/g, '');
  if (!s.startsWith('+994')) return null;
  const rest = s.slice(4);
  if (!/^\d{9}$/.test(rest)) return null;
  return '+994' + rest;
}

export function mdBoldBig(text) {
  // Telegram doesn't support font size, but we can mimic with bold + emojis
  return `*${text}*`;
}
