import express from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getPricing } from '../lib/settings.js';
import { haversineKm, calcFare } from '../lib/fare.js';

const router = express.Router();

const CreateRideSchema = z.object({
  pickupLat: z.number(),
  pickupLng: z.number(),
  pickupText: z.string().optional().nullable(),
  dropoffLat: z.number(),
  dropoffLng: z.number(),
  dropoffText: z.string().optional().nullable()
});

router.post('/', async (req, res) => {
  const parsed = CreateRideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  const b = parsed.data;
  const pricing = await getPricing();
  const dist = haversineKm(b.pickupLat, b.pickupLng, b.dropoffLat, b.dropoffLng);
  const { distanceKm, fareAzN, commissionAzN } = calcFare(dist, pricing);

  const ride = await prisma.ride.create({
    data: {
      passengerId: req.user.id,
      pickupLat: b.pickupLat,
      pickupLng: b.pickupLng,
      pickupText: b.pickupText ?? null,
      dropoffLat: b.dropoffLat,
      dropoffLng: b.dropoffLng,
      dropoffText: b.dropoffText ?? null,
      distanceKm,
      fareAzN,
      commissionAzN,
      status: 'REQUESTED'
    }
  });

  res.json({ ride });
});

router.get('/me', async (req, res) => {
  const rides = await prisma.ride.findMany({
    where: {
      OR: [{ passengerId: req.user.id }, { driverId: req.user.id }]
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.json({ rides });
});

router.post('/:id/cancel', async (req, res) => {
  const id = String(req.params.id);
  const ride = await prisma.ride.findUnique({ where: { id } });
  if (!ride) return res.status(404).json({ error: 'Not found' });
  if (ride.passengerId !== req.user.id && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });
  if (['COMPLETED', 'CANCELED'].includes(ride.status)) return res.status(400).json({ error: 'Cannot cancel' });

  const upd = await prisma.ride.update({ where: { id }, data: { status: 'CANCELED' } });
  res.json({ ride: upd });
});

export default router;
