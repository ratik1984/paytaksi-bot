import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { verifyTelegramInitData } from '../lib/telegram.js';

const router = express.Router();

const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(4) });

router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  const { email, password } = parsed.data;

  const user = await prisma.user.findFirst({ where: { phone: email } }); // using phone field as 'email' placeholder
  if (!user || !user.passwordHash) return res.status(401).json({ error: 'Bad credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Bad credentials' });

  const token = signToken(user);
  res.json({ token, user: safeUser(user) });
});

router.post('/telegram', async (req, res) => {
  const initData = req.body?.initData;
  const r = verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!r.ok) return res.status(401).json({ error: r.error });

  const tg = r.user;
  if (!tg?.id) return res.status(400).json({ error: 'No telegram user' });

  const telegramId = String(tg.id);
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || 'User';

  let user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId,
        name,
        role: 'PASSENGER'
      }
    });
  } else {
    // keep name up to date
    user = await prisma.user.update({ where: { id: user.id }, data: { name } });
  }

  const token = signToken(user);
  res.json({ token, user: safeUser(user) });
});

function signToken(user) {
  const secret = process.env.JWT_SECRET || 'dev_secret';
  return jwt.sign({ id: user.id, role: user.role, telegramId: user.telegramId }, secret, { expiresIn: '30d' });
}

function safeUser(u) {
  return { id: u.id, name: u.name, role: u.role, telegramId: u.telegramId };
}

export default router;
