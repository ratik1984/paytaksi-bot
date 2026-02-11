import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';

import { prisma } from './lib/prisma.js';
import { ensureDefaultSettings } from './lib/settings.js';
import { requireAuth, requireRole } from './middleware/auth.js';

import authRouter from './routes/auth.js';
import ridesRouter from './routes/rides.js';
import driverRouter from './routes/driver.js';
import placesRouter from './routes/places.js';
import topupsRouter from './routes/topups.js';
import adminRouter from './routes/admin.js';
import bcrypt from 'bcryptjs';

const app = express();

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// static uploads (Render disk can be ephemeral; for prod use S3)
const uploadDir = process.env.UPLOAD_DIR || 'uploads';
app.use('/uploads', express.static(path.resolve(uploadDir)));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRouter);
app.use('/places', placesRouter);

app.use('/rides', requireAuth, ridesRouter);
app.use('/driver', requireAuth, requireRole(['DRIVER', 'ADMIN']), driverRouter);
app.use('/topups', requireAuth, topupsRouter);
app.use('/admin', requireAuth, requireRole(['ADMIN']), adminRouter);

const port = parseInt(process.env.PORT || '3000', 10);

async function bootstrap() {
  await ensureDefaultSettings();

  // Bootstrap admin user (password auth for admin panel)
  const adminLogin = process.env.ADMIN_LOGIN;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminLogin && adminPassword) {
    const existing = await prisma.user.findFirst({ where: { phone: adminLogin } });
    if (!existing) {
      const hash = await bcrypt.hash(adminPassword, 10);
      await prisma.user.create({
        data: {
          phone: adminLogin,
          passwordHash: hash,
          role: 'ADMIN',
          name: 'Admin'
        }
      });
      console.log('✅ Admin user created:', adminLogin);
    }
  } else {
    console.log('ℹ️  ADMIN_LOGIN/ADMIN_PASSWORD not set. Admin panel login disabled until set.');
  }

  app.listen(port, () => console.log(`PayTaksi API running on :${port}`));
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
