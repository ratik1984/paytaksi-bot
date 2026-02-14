export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  if ([lat1, lon1, lat2, lon2].some(v => typeof v !== 'number' || Number.isNaN(v))) return 0;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function calcPrice(distanceKm) {
  const base = Number(process.env.BASE_FARE ?? 1.5);
  const perKm = Number(process.env.PER_KM ?? 0.5);
  const commissionRate = Number(process.env.COMMISSION_RATE ?? 0.1);
  const price = Math.max(base, base + distanceKm * perKm);
  const commission = price * commissionRate;
  return {
    price: Number(price.toFixed(2)),
    commission: Number(commission.toFixed(2))
  };
}

export function nowIso() {
  return new Date().toISOString();
}
