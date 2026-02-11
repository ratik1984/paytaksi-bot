import express from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getPricing, setSetting } from '../lib/settings.js';

const router = express.Router();

router.get('/dashboard', async (_req, res) => {
  const [users, drivers, rides, topups] = await Promise.all([
    prisma.user.count(),
    prisma.driverProfile.count(),
    prisma.ride.count(),
    prisma.topupRequest.count()
  ]);
  res.json({ users, drivers, rides, topups, pricing: await getPricing() });
});

router.get('/drivers', async (_req, res) => {
  const items = await prisma.driverProfile.findMany({
    include: { user: true, documents: true },
    orderBy: { user: { createdAt: 'desc' } },
    take: 100
  });
  res.json({ items });
});

router.post('/drivers/:id/verify', async (req, res) => {
  const id = String(req.params.id);
  const schema = z.object({ isVerified: z.boolean(), isActive: z.boolean().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  const upd = await prisma.driverProfile.update({
    where: { id },
    data: {
      isVerified: parsed.data.isVerified,
      ...(parsed.data.isActive == null ? {} : { isActive: parsed.data.isActive })
    }
  });
  res.json({ profile: upd });
});

router.post('/documents/:id/status', async (req, res) => {
  const id = String(req.params.id);
  const schema = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']), note: z.string().optional().nullable() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  const upd = await prisma.driverDocument.update({
    where: { id },
    data: { status: parsed.data.status, note: parsed.data.note ?? null }
  });
  res.json({ document: upd });
});

router.get('/topups', async (_req, res) => {
  const items = await prisma.topupRequest.findMany({ include: { user: true }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ items });
});

router.post('/topups/:id/decision', async (req, res) => {
  const id = String(req.params.id);
  const schema = z.object({ status: z.enum(['APPROVED', 'REJECTED']), adminNote: z.string().optional().nullable() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  const item = await prisma.topupRequest.findUnique({ where: { id } });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.status !== 'PENDING') return res.status(400).json({ error: 'Already processed' });

  const upd = await prisma.topupRequest.update({ where: { id }, data: { status: parsed.data.status, adminNote: parsed.data.adminNote ?? null } });

  if (parsed.data.status === 'APPROVED') {
    // If user is driver, add to driver balance
    const prof = await prisma.driverProfile.findUnique({ where: { userId: item.userId } });
    if (prof) {
      await prisma.driverProfile.update({ where: { userId: item.userId }, data: { balance: { increment: item.amountAzN } } });
    }
  }

  res.json({ request: upd });
});

router.post('/settings', async (req, res) => {
  const schema = z.object({
    COMMISSION_RATE: z.string().optional(),
    BASE_FARE_AZN: z.string().optional(),
    INCLUDED_KM: z.string().optional(),
    PER_KM_AZN: z.string().optional(),
    DRIVER_BLOCK_BALANCE: z.string().optional(),
    MIN_CAR_YEAR: z.string().optional(),
    ALLOWED_CAR_COLORS: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  for (const [k, v] of Object.entries(parsed.data)) {
    if (v != null) await setSetting(k, v);
  }
  res.json({ ok: true, pricing: await getPricing() });
});

export default router;
