function getPricingFromEnv(){
  return {
    baseFare: parseFloat(process.env.BASE_FARE || "3.50"),
    freeKm: parseFloat(process.env.FREE_KM || "3"),
    perKm: parseFloat(process.env.PER_KM || "0.40"),
    commissionRate: parseFloat(process.env.COMMISSION_RATE || "0.10"),
    minDriverBalance: parseFloat(process.env.MIN_DRIVER_BALANCE || "-10"),
  };
}
function calcFare(distanceKm, p){
  const d=Math.max(0, Number(distanceKm||0));
  const extra=Math.max(0, d - p.freeKm);
  return Math.round((p.baseFare + extra*p.perKm)*100)/100;
}
function calcCommission(fare, p){
  return Math.round(Number(fare)*p.commissionRate*100)/100;
}
module.exports = { getPricingFromEnv, calcFare, calcCommission };
