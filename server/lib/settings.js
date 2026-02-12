import { prisma } from "./prisma.js";
const defaults = { commission_percent:"10", base_fare:"3.50", included_km:"3", per_km_after:"0.40", driver_block_balance:"-10" };
export async function initSettings(){ for (const [k,v] of Object.entries(defaults)) await prisma.setting.upsert({where:{key:k},update:{},create:{key:k,value:v}}); }
export async function getSettingNumber(key,fallback){ const r=await prisma.setting.findUnique({where:{key}}); if(!r) return fallback; const n=Number(r.value); return Number.isFinite(n)?n:fallback; }
export async function setSetting(key,value){ await prisma.setting.upsert({where:{key},update:{value:String(value)},create:{key,value:String(value)}}); }
