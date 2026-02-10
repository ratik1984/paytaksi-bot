/**
 * Simple driver matching:
 * - selects online + approved drivers
 * - ranks by distance to pickup (Haversine)
 * - sends offers to top N drivers
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat/2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function rankDrivers(drivers, pickupLat, pickupLng) {
  return drivers
    .map(d => ({
      ...d,
      distance_km: haversineKm(pickupLat, pickupLng, d.last_lat, d.last_lng)
    }))
    .sort((a,b)=>a.distance_km-b.distance_km);
}
