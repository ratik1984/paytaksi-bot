const bcrypt = require("bcryptjs");
const { prisma } = require("../db");

async function ensureAdminSeedFromEnv(env){
  const email = env.ADMIN_EMAIL;
  const pass = env.ADMIN_PASSWORD;
  if (!email || !pass) return;

  const existing = await prisma.adminProfile.findUnique({ where:{ email }});
  if (existing) return;

  // create a special admin user (telegramId placeholder)
  const user = await prisma.user.create({ data:{ telegramId: "0", role:"ADMIN", firstName:"Admin" }});
  const hash = await bcrypt.hash(pass, 10);
  await prisma.adminProfile.create({ data:{ userId:user.id, email, passwordHash:hash }});
}

function requireLogin(req, res, next){
  if (req.cookies?.admin === "1") return next();
  return res.redirect("/admin/login");
}

module.exports = { ensureAdminSeedFromEnv, requireLogin };
