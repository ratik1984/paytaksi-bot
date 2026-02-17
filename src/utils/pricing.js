export function calcFare(distanceKm, pricing) {
  const d = Math.max(0, Number(distanceKm || 0));
  const base = pricing.baseFare;
  const baseKm = pricing.baseDistanceKm;
  const per = pricing.perKmAfterBase;
  if (d <= baseKm) return round2(base);
  return round2(base + (d - baseKm) * per);
}

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
