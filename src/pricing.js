export function calcPrice({ baseFare, perKm, perMin }, { distanceKm = 0, durationMin = 0 }) {
  const v = baseFare + perKm * distanceKm + perMin * durationMin
  return Math.round(v * 100) / 100
}
