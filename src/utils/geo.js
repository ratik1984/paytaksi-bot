const axios = require("axios");

function toRad(x){ return x * Math.PI / 180; }
function haversineKm(aLat, aLng, bLat, bLng){
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s1 = Math.sin(dLat/2);
  const s2 = Math.sin(dLng/2);
  const aa = s1*s1 + Math.cos(toRad(aLat))*Math.cos(toRad(bLat))*s2*s2;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
  return R * c;
}

/**
 * Tries OSRM public router first (road distance), fallback to haversine.
 * OSRM: https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=false
 */
async function distanceKm(aLat, aLng, bLat, bLng){
  try{
    const url = `https://router.project-osrm.org/route/v1/driving/${aLng},${aLat};${bLng},${bLat}?overview=false`;
    const r = await axios.get(url, { timeout: 8000 });
    const meters = r.data?.routes?.[0]?.distance;
    if (typeof meters === "number" && meters > 0) return meters / 1000;
  }catch(e){}
  return haversineKm(aLat, aLng, bLat, bLng);
}

module.exports = { distanceKm, haversineKm };
