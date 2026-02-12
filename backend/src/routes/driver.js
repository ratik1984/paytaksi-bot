import { Router } from "express";
import multer from "multer";
import path from "path";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../lib/auth.js";
import { CONFIG } from "../lib/config.js";

const router = Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, new URL("../../uploads", import.meta.url).pathname),
  filename: (req, file, cb) => {
    const safe = Date.now() + "-" + Math.random().toString(16).slice(2) + path.extname(file.originalname || ".jpg");
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 6 * 1024 * 1024 } });

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.uid },
    include: { driverProfile: { include: { documents: true } } }
  });
  res.json({ user });
});

router.post("/register", requireAuth, async (req, res) => {
  // set role to DRIVER
  await prisma.user.update({ where: { id: req.user.uid }, data: { role: "DRIVER" } });

  const schema = z.object({
    carYear: z.number().int(),
    carColor: z.string(),
    carModel: z.string().optional(),
    carPlate: z.string().optional()
  });
  const body = schema.parse(req.body);

  if (body.carYear < CONFIG.driverMinYear) {
    return res.status(400).json({ error: "MIN_YEAR", min: CONFIG.driverMinYear });
  }
  const color = body.carColor.toLowerCase().trim();
  if (!CONFIG.allowedColors.includes(color)) {
    return res.status(400).json({ error: "INVALID_COLOR", allowed: CONFIG.allowedColors });
  }

  const existing = await prisma.driverProfile.findUnique({ where: { userId: req.user.uid } });
  const driver = existing
    ? await prisma.driverProfile.update({
        where: { userId: req.user.uid },
        data: { carYear: body.carYear, carColor: color, carModel: body.carModel, carPlate: body.carPlate }
      })
    : await prisma.driverProfile.create({
        data: { userId: req.user.uid, carYear: body.carYear, carColor: color, carModel: body.carModel, carPlate: body.carPlate }
      });

  res.json({ ok: true, driver });
});

// Upload documents (6 files)
router.post("/documents", requireAuth,
  upload.fields([
    { name: "id_front", maxCount: 1 },
    { name: "id_back", maxCount: 1 },
    { name: "dl_front", maxCount: 1 },
    { name: "dl_back", maxCount: 1 },
    { name: "tp_front", maxCount: 1 },
    { name: "tp_back", maxCount: 1 }
  ]),
  async (req, res) => {
    const driver = await prisma.driverProfile.findUnique({ where: { userId: req.user.uid } });
    if (!driver) return res.status(400).json({ error: "REGISTER_FIRST" });

    const files = req.files || {};
    const keys = ["id_front","id_back","dl_front","dl_back","tp_front","tp_back"];
    const created = [];
    for (const k of keys) {
      const f = files[k]?.[0];
      if (!f) continue;
      const rec = await prisma.driverDocument.create({
        data: { driverId: driver.id, type: k, path: "/uploads/" + f.filename }
      });
      created.push(rec);
    }
    res.json({ ok: true, documents: created });
  }
);

// Driver location update (used for matching + live map)
router.post("/location", requireAuth, async (req, res) => {
  const body = z.object({
    lat: z.number(),
    lng: z.number(),
    heading: z.number().optional(),
    speed: z.number().optional()
  }).parse(req.body);

  const driver = await prisma.driverProfile.findUnique({ where: { userId: req.user.uid } });
  if (!driver) return res.status(400).json({ error: "REGISTER_FIRST" });
  if (driver.status !== "APPROVED") return res.status(403).json({ error: "NOT_APPROVED" });

  await prisma.driverLocation.create({
    data: { driverId: driver.id, lat: body.lat, lng: body.lng, heading: body.heading, speed: body.speed }
  });

  // emit to passenger if in active ride later (v2.1)
  res.json({ ok: true });
});


// Request top-up (card2card or m10) - admin approves
router.post("/topup", requireAuth, async (req, res) => {
  const body = z.object({
    method: z.enum(["card2card","m10"]),
    amount: z.number().positive(),
    note: z.string().optional()
  }).parse(req.body);

  const t = await prisma.topUpRequest.create({
    data: { userId: req.user.uid, method: body.method, amount: body.amount, note: body.note || null }
  });
  res.json({ ok: true, topup: t });
});

export default router;
