const { query } = require("./db");
const { haversineKm } = require("./geo");

const pendingOffers = new Map(); // tripId -> {driverIds:Set, acceptedBy, expiresAt}

async function findNearbyDrivers({lat,lng,radiusKm=6,limit=5,minBalance=-10}){
  const res = await query(`
    SELECT d.id as driver_id, d.rating, d.reject_count, d.wallet_balance,
           dl.lat, dl.lng, dl.updated_at
    FROM drivers d
    JOIN driver_locations dl ON dl.driver_id=d.id
    WHERE d.status='online'
      AND d.wallet_balance >= $1
      AND dl.updated_at > NOW() - INTERVAL '2 minutes'
  `,[minBalance]);

  const scored = res.rows.map(r=>{
    const dist = haversineKm(lat,lng, Number(r.lat), Number(r.lng));
    const score = (10 - Math.min(10, dist)) + Number(r.rating||5)*0.8 - Number(r.reject_count||0)*0.3;
    return {...r, dist_km:dist, score};
  }).filter(r=>r.dist_km<=radiusKm);

  scored.sort((a,b)=>b.score-a.score);
  return scored.slice(0,limit);
}

function createOffer(tripId, driverIds, ttlMs=20000){
  pendingOffers.set(tripId, { driverIds:new Set(driverIds), acceptedBy:null, expiresAt:Date.now()+ttlMs });
  setTimeout(()=>{
    const o=pendingOffers.get(tripId);
    if(o && !o.acceptedBy && Date.now()>=o.expiresAt) pendingOffers.delete(tripId);
  }, ttlMs+100);
}
function acceptOffer(tripId, driverId){
  const o=pendingOffers.get(tripId);
  if(!o) return false;
  if(o.acceptedBy) return false;
  if(!o.driverIds.has(driverId)) return false;
  o.acceptedBy=driverId;
  pendingOffers.set(tripId,o);
  return true;
}
function clearOffer(tripId){ pendingOffers.delete(tripId); }

module.exports = { findNearbyDrivers, createOffer, acceptOffer, clearOffer };
