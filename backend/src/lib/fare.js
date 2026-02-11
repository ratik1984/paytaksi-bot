export function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function calcFare(distanceKm, pricing) {
  const d = Math.max(0, distanceKm);
  const extra = Math.max(0, d - pricing.includedKm);
  const fare = pricing.base + extra * pricing.perKm;
  const commission = fare * pricing.commissionRate;
  return {
    distanceKm: round2(d),
    fareAzN: round2(fare),
    commissionAzN: round2(commission)
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
