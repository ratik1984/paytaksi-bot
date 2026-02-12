import { getSettingNumber } from "./settings.js";
export async function calcFare(distanceKm){
  const base=await getSettingNumber("base_fare",3.50);
  const included=await getSettingNumber("included_km",3);
  const perAfter=await getSettingNumber("per_km_after",0.40);
  const percent=await getSettingNumber("commission_percent",10);
  let fare=base;
  if(distanceKm>included) fare += (distanceKm-included)*perAfter;
  fare=Math.round(fare*100)/100;
  const commission=Math.round((fare*(percent/100))*100)/100;
  return {fare,commission};
}
