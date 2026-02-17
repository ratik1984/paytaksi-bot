function round2(n){ return Math.round(n*100)/100; }

/**
 * Pricing rule (AZN):
 * Base 3.50 AZN, includes first 3 km.
 * After 3 km: +0.40 AZN per 1 km.
 */
function calcFare(distanceKm){
  const base = 3.50;
  const extraKm = Math.max(0, distanceKm - 3);
  const fare = base + extraKm * 0.40;
  return round2(fare);
}

function calcCommission(fareAzN){
  return round2(fareAzN * 0.10);
}

module.exports = { calcFare, calcCommission, round2 };
