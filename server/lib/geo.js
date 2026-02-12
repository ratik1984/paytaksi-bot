import axios from "axios";
const NOMINATIM = process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org";
const OSRM = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const UA = "PayTaksiBot/1.0";
export async function searchPlaces(q, nearLat=null, nearLon=null){
  const params={q,format:"jsonv2",addressdetails:1,limit:6};
  if(nearLat!=null && nearLon!=null){ params.viewbox=`${nearLon-0.1},${nearLat+0.1},${nearLon+0.1},${nearLat-0.1}`; params.bounded=0; }
  const res=await axios.get(`${NOMINATIM}/search`,{params,headers:{"User-Agent":UA}});
  return (res.data||[]).map(x=>({display:x.display_name,lat:Number(x.lat),lon:Number(x.lon)}));
}
export async function routeDistanceKm(pickLat,pickLon,dropLat,dropLon){
  const url=`${OSRM}/route/v1/driving/${pickLon},${pickLat};${dropLon},${dropLat}`;
  const res=await axios.get(url,{params:{overview:"false"},headers:{"User-Agent":UA}});
  const meters=res.data?.routes?.[0]?.distance ?? null;
  if(meters==null) throw new Error("OSRM route not available");
  return meters/1000.0;
}
