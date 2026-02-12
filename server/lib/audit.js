import { prisma } from "./prisma.js";
export async function audit(action, meta=null, actorTgId=null){ await prisma.auditLog.create({data:{action,meta:meta?JSON.stringify(meta):null,actorTgId:actorTgId?BigInt(actorTgId):null}}); }
