import fetch from 'node-fetch';

export async function routeDistanceKm(pickup, drop) {
  const base = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org';
  const url = `${base}/route/v1/driving/${pickup.lon},${pickup.lat};${drop.lon},${drop.lat}?overview=false`;
  const r = await fetch(url, { timeout: 15000 });
  if (!r.ok) throw new Error(`OSRM error ${r.status}`);
  const data = await r.json();
  const meters = data?.routes?.[0]?.distance;
  if (typeof meters !== 'number') throw new Error('OSRM no distance');
  return meters / 1000;
}
