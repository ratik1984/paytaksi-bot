import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import jwt from "jsonwebtoken";
import { requireAuth, requireAdmin } from "../lib/auth.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

router.post("/login", async (req, res) => {
  const body = z.object({ login: z.string(), password: z.string() }).parse(req.body);
  const admin = await prisma.adminUser.findUnique({ where: { login: body.login } });
  if (!admin) return res.status(401).json({ error: "invalid" });
  const ok = await bcrypt.compare(body.password, admin.passHash);
  if (!ok) return res.status(401).json({ error: "invalid" });

  const token = jwt.sign({ uid: admin.id, role: "ADMIN" }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token });
});

// attach req.user via requireAuth then allow admin
router.get("/drivers", requireAuth, requireAdmin, async (req, res) => {
  const status = String(req.query.status || "PENDING");
  const drivers = await prisma.driverProfile.findMany({
    where: { status: status },
    include: { user: true, documents: true }
  });
  res.json({ drivers });
});

router.post("/drivers/status", requireAuth, requireAdmin, async (req, res) => {
  const body = z.object({
    userId: z.string(),
    status: z.enum(["APPROVED","REJECTED","PENDING"])
  }).parse(req.body);

  const driver = await prisma.driverProfile.update({
    where: { userId: body.userId },
    data: { status: body.status }
  });
  res.json({ ok: true, driver });
});

router.get("/topups", requireAuth, requireAdmin, async (req, res) => {
  const topups = await prisma.topUpRequest.findMany({ include: { user: true }, orderBy: { createdAt: "desc" }, take: 100 });
  res.json({ topups });
});

router.post("/topups/decision", requireAuth, requireAdmin, async (req, res) => {
  const body = z.object({ id: z.string(), decision: z.enum(["APPROVED","REJECTED"]) }).parse(req.body);
  const t = await prisma.topUpRequest.update({ where: { id: body.id }, data: { status: body.decision } });

  if (body.decision === "APPROVED") {
    // if driver has profile, add balance there; otherwise ignore
    const prof = await prisma.driverProfile.findUnique({ where: { userId: t.userId } });
    if (prof) {
      await prisma.driverProfile.update({ where: { userId: t.userId }, data: { balance: { increment: t.amount } } });
    }
  }
  res.json({ ok: true, topup: t });
});

router.get("/settings", requireAuth, requireAdmin, async (req, res) => {
  const settings = await prisma.setting.findMany();
  res.json({ settings });
});

router.post("/settings", requireAuth, requireAdmin, async (req, res) => {
  const body = z.object({
    commissionRate: z.number().optional(),
    startFare: z.number().optional(),
    freeKm: z.number().optional(),
    perKmAfter: z.number().optional(),
    driverMinBalance: z.number().optional(),
    driverMinYear: z.number().optional()
  }).parse(req.body);

  const entries = Object.entries(body).filter(([,v]) => typeof v === "number");
  for (const [key, v] of entries) {
    await prisma.setting.upsert({ where: { key }, update: { value: String(v) }, create: { key, value: String(v) } });
  }
  res.json({ ok: true });
});

export default router;
