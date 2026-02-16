const { pool } = require('./db');

async function getPricing() {
  const { rows } = await pool.query('SELECT * FROM pricing_settings WHERE id=1');
  const p = rows[0];
  if (p) {
    return {
      baseFare: Number(p.base_fare),
      includedKm: Number(p.included_km),
      perKm: Number(p.per_km),
      commissionRate: Number(p.commission_rate)
    };
  }
  return {
    baseFare: Number(process.env.BASE_FARE || 3.5),
    includedKm: Number(process.env.INCLUDED_KM || 3),
    perKm: Number(process.env.PER_KM || 0.4),
    commissionRate: Number(process.env.COMMISSION_RATE || 0.1)
  };
}

function calcFare(distanceKm, pricing) {
  const extra = Math.max(0, distanceKm - pricing.includedKm);
  const fare = pricing.baseFare + extra * pricing.perKm;
  const commission = fare * pricing.commissionRate;
  const driverEarn = fare - commission;
  const round2 = (x) => Math.round(x * 100) / 100;
  return {
    fare: round2(fare),
    commission: round2(commission),
    driverEarn: round2(driverEarn)
  };
}

module.exports = { getPricing, calcFare };
