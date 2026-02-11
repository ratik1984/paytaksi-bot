import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { prisma } from '../lib/prisma.js';
import { getPricing } from '../lib/settings.js';
import { haversineKm } from '../lib/fare.js';

const router = express.Router();

const uploadDir = process.env.UPLOAD_DIR || 'uploads';
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `${req.user.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 6 * 1024 * 1024 } });

const DriverRegisterSchema = z.object({
  carYear: z.number().int(),
  carColor: z.string().min(2),
  carMake: z.string().optional().nullable(),
  carModel: z.string().optional().nullable(),
  carPlate: z.string().optional().nullable()
});

router.get('/me', async (req, res) => {
  const profile = await prisma.driverProfile.findUnique({
    where: { userId: req.user.id },
    include: { documents: true }
  });
  res.json({ profile });
});

router.post('/register', async (req, res) => {
  const parsed = DriverRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  const b = parsed.data;

  const pricing = await getPricing();
  if (b.carYear < pricing.minCarYear) return res.status(400).json({ error: `Minimum car year is ${pricing.minCarYear}` });
  const allowed = pricing.allowedColors.map((x) => x.toLowerCase());
  if (!allowed.includes(b.carColor.toLowerCase())) {
    return res.status(400).json({ error: `Allowed colors: ${pricing.allowedColors.join(', ')}` });
  }

  const existing = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  let profile;
  if (!existing) {
    profile = await prisma.driverProfile.create({
      data: {
        userId: req.user.id,
        carYear: b.carYear,
        carColor: b.carColor,
        carMake: b.carMake ?? null,
        carModel: b.carModel ?? null,
        carPlate: b.carPlate ?? null
      }
    });
  } else {
    profile = await prisma.driverProfile.update({
      where: { userId: req.user.id },
      data: {
        carYear: b.carYear,
        carColor: b.carColor,
        carMake: b.carMake ?? null,
        carModel: b.carModel ?? null,
        carPlate: b.carPlate ?? null
      }
    });
  }

  // Ensure role
  await prisma.user.update({ where: { id: req.user.id }, data: { role: 'DRIVER' } });
  res.json({ profile });
});

router.post('/location', async (req, res) => {
  const schema = z.object({ lat: z.number(), lng: z.number() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  const { lat, lng } = parsed.data;

  const profile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(400).json({ error: 'Driver not registered' });

  await prisma.driverProfile.update({
    where: { userId: req.user.id },
    data: { lastLat: lat, lastLng: lng, lastSeenAt: new Date() }
  });
  res.json({ ok: true });
});

router.get('/nearby-requests', async (req, res) => {
  const lat = parseFloat(String(req.query.lat || ''));
  const lng = parseFloat(String(req.query.lng || ''));
  const radiusKm = Math.min(10, Math.max(1, parseFloat(String(req.query.radiusKm || '3'))));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat/lng required' });

  const profile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(400).json({ error: 'Driver not registered' });
  if (!profile.isActive) return res.status(403).json({ error: 'Driver inactive' });

  const pricing = await getPricing();
  if (Number(profile.balance) <= pricing.blockBal) {
    return res.status(403).json({ error: `Balance is ${profile.balance}. You cannot take orders below ${pricing.blockBal} AZN.` });
  }

  const requested = await prisma.ride.findMany({
    where: { status: 'REQUESTED' },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  const items = requested
    .map((r) => ({
      ride: r,
      distanceToPickupKm: haversineKm(lat, lng, r.pickupLat, r.pickupLng)
    }))
    .filter((x) => x.distanceToPickupKm <= radiusKm)
    .sort((a, b) => a.distanceToPickupKm - b.distanceToPickupKm)
    .slice(0, 20);

  res.json({ items });
});

router.post('/:id/accept', async (req, res) => {
  const id = String(req.params.id);

  const profile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(400).json({ error: 'Driver not registered' });
  const pricing = await getPricing();
  if (Number(profile.balance) <= pricing.blockBal) {
    return res.status(403).json({ error: 'Insufficient balance' });
  }

  const ride = await prisma.ride.findUnique({ where: { id } });
  if (!ride) return res.status(404).json({ error: 'Not found' });
  if (ride.status !== 'REQUESTED') return res.status(400).json({ error: 'Already taken' });

  const upd = await prisma.ride.update({ where: { id }, data: { driverId: req.user.id, status: 'ASSIGNED' } });
  res.json({ ride: upd });
});

router.post('/:id/status', async (req, res) => {
  const id = String(req.params.id);
  const schema = z.object({ status: z.enum(['ARRIVED', 'STARTED', 'COMPLETED', 'CANCELED']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  const ride = await prisma.ride.findUnique({ where: { id } });
  if (!ride) return res.status(404).json({ error: 'Not found' });
  if (ride.driverId !== req.user.id && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });

  const status = parsed.data.status;
  const upd = await prisma.ride.update({ where: { id }, data: { status } });

  // On completed: apply commission to driver balance
  if (status === 'COMPLETED') {
    const profile = await prisma.driverProfile.findUnique({ where: { userId: ride.driverId } });
    if (profile && ride.commissionAzN != null) {
      // driver pays commission (balance decreases)
      await prisma.driverProfile.update({
        where: { userId: ride.driverId },
        data: { balance: { decrement: ride.commissionAzN } }
      });
    }
  }

  res.json({ ride: upd });
});

router.post('/documents/upload', upload.single('file'), async (req, res) => {
  const schema = z.object({ type: z.enum(['ID_FRONT','ID_BACK','LICENSE_FRONT','LICENSE_BACK','CAR_REG_FRONT','CAR_REG_BACK']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'type is required' });
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  const profile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(400).json({ error: 'Driver not registered' });

  const doc = await prisma.driverDocument.upsert({
    where: { driverId_type: { driverId: profile.id, type: parsed.data.type } },
    update: { filePath: req.file.path, status: 'PENDING', note: null },
    create: { driverId: profile.id, type: parsed.data.type, filePath: req.file.path }
  });

  res.json({ document: doc });
});

export default router;
