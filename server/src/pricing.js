function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function calcFare({ distanceKm, baseFare, includedKm, perKm, surgeMultiplier, commissionPct }) {
  const d = Math.max(0, Number(distanceKm || 0));
  const base = Number(baseFare);
  const inc = Number(includedKm);
  const per = Number(perKm);
  const surge = Number(surgeMultiplier || 1);
  const commPct = Number(commissionPct || 10);

  let subtotal = base;
  if (d > inc) subtotal += (d - inc) * per;

  const total = round2(subtotal * surge);
  const commission = round2(total * (commPct / 100));
  const driverEarn = round2(total - commission);

  return {
    distance_km: round2(d),
    base_fare: round2(base),
    included_km: round2(inc),
    per_km: round2(per),
    surge_multiplier: surge,
    total_fare: total,
    commission_pct: commPct,
    commission_amount: commission,
    driver_earnings: driverEarn
  };
}

module.exports = { calcFare };
