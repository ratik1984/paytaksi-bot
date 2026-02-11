import express from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

const router = express.Router();

const CreateSchema = z.object({
  method: z.enum(['CARD_TO_CARD', 'M10']),
  amountAzN: z.number().positive(),
  note: z.string().optional().nullable()
});

router.post('/', async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  const b = parsed.data;

  const row = await prisma.topupRequest.create({
    data: {
      userId: req.user.id,
      method: b.method,
      amountAzN: b.amountAzN,
      note: b.note ?? null
    }
  });

  res.json({ request: row });
});

router.get('/me', async (req, res) => {
  const items = await prisma.topupRequest.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ items });
});

export default router;
