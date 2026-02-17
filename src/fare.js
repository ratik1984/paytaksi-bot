export function calcFare(distanceKm) {
  const base = Number(process.env.BASE_FARE_AZN || 3.5);
  const freeKm = Number(process.env.FREE_KM || 3);
  const perKm = Number(process.env.PER_KM_AFTER_FREE_AZN || 0.4);
  const d = Math.max(0, Number(distanceKm) || 0);
  const extra = Math.max(0, d - freeKm) * perKm;
  const fare = base + extra;
  return Number(fare.toFixed(2));
}

export function calcCommission(fareAzn) {
  const rate = Number(process.env.DRIVER_COMMISSION_RATE || 0.1);
  const c = (Number(fareAzn) || 0) * rate;
  return Number(c.toFixed(2));
}
