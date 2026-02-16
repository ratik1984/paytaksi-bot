const fetch = require('node-fetch');

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function routeDistanceKm(pickup, drop) {
  // Try OSRM public server; fallback to haversine
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${pickup.lng},${pickup.lat};${drop.lng},${drop.lat}?overview=false`;
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) throw new Error('OSRM not ok');
    const j = await r.json();
    const meters = j?.routes?.[0]?.distance;
    if (!meters) throw new Error('No distance');
    return meters / 1000;
  } catch {
    // Approximate driving distance by scaling haversine
    return haversineKm(pickup.lat, pickup.lng, drop.lat, drop.lng) * 1.25;
  }
}

module.exports = { haversineKm, routeDistanceKm };
