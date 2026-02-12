import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { CONFIG } from "./config.js";

export async function bootstrap() {
  const defaults = [
    ["commissionRate", String(CONFIG.commissionRate)],
    ["startFare", String(CONFIG.startFare)],
    ["freeKm", String(CONFIG.freeKm)],
    ["perKmAfter", String(CONFIG.perKmAfter)],
    ["driverMinBalance", String(CONFIG.driverMinBalance)],
    ["driverMinYear", String(CONFIG.driverMinYear)]
  ];
  for (const [key, value] of defaults) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }

  // Create default admin if missing (login/pass from env)
  const login = process.env.ADMIN_LOGIN || "Ratik";
  const pass = process.env.ADMIN_PASSWORD || "0123456789";
  const existing = await prisma.adminUser.findUnique({ where: { login } });
  if (!existing) {
    const passHash = await bcrypt.hash(pass, 10);
    await prisma.adminUser.create({ data: { login, passHash } });
  }
}
