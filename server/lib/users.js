import { prisma } from "./prisma.js";

import { audit } from "./audit.js";

export async function getOrCreatePassenger(tgId){
  await prisma.user.upsert({ where:{tgId:BigInt(tgId)}, update:{}, create:{tgId:BigInt(tgId), role:PASSENGER, passenger:{create:{}}} });
  return prisma.user.findUnique({ where:{tgId:BigInt(tgId)}, include:{ passenger:true } });
}
export async function getOrCreateDriver(tgId){
  await prisma.user.upsert({ where:{tgId:BigInt(tgId)}, update:{}, create:{tgId:BigInt(tgId), role:DRIVER, driver:{create:{}}} });
  return prisma.user.findUnique({ where:{tgId:BigInt(tgId)}, include:{ driver:true } });
}
export async function ensureAdmin(tgId){
  const ex=await prisma.user.findUnique({ where:{tgId:BigInt(tgId)}, include:{ admin:true } });
  if (ex?.admin) return ex;
  await prisma.user.upsert({ where:{tgId:BigInt(tgId)}, update:{role:ADMIN}, create:{tgId:BigInt(tgId), role:ADMIN, admin:{create:{}}} });
  const u=await prisma.user.findUnique({ where:{tgId:BigInt(tgId)} });
  await prisma.admin.upsert({ where:{userId:u.id}, update:{}, create:{userId:u.id} });
  await audit("admin_ensure",{tgId},tgId);
  return prisma.user.findUnique({ where:{tgId:BigInt(tgId)}, include:{ admin:true } });
}
