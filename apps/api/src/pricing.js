export function computeFare(distanceKm, startFare=3.50, freeKm=3, perKm=0.40) {
  const d = Number(distanceKm || 0);
  const fare = startFare + Math.max(0, d - freeKm) * perKm;
  return Math.round(fare * 100) / 100;
}
