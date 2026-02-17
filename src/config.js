import 'dotenv/config';

export const cfg = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL,

  passengerBotToken: process.env.PASSENGER_BOT_TOKEN,
  driverBotToken: process.env.DRIVER_BOT_TOKEN,
  adminBotToken: process.env.ADMIN_BOT_TOKEN,

  superAdminId: Number(process.env.SUPER_ADMIN_ID || 0),
  adminWebUser: process.env.ADMIN_WEB_USER || 'admin',
  adminWebPass: process.env.ADMIN_WEB_PASS || 'admin',

  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // Telegram Mini App (WebApp) initData verification
  // If you are testing locally without Telegram, set ALLOW_TG_UNSAFE=1 and pass tg_id as query param.
  allowTgUnsafe: String(process.env.ALLOW_TG_UNSAFE || '0') === '1',

  pricing: {
    baseFare: Number(process.env.BASE_FARE_AZN || 3.5),
    baseDistanceKm: Number(process.env.BASE_DISTANCE_KM || 3),
    perKmAfterBase: Number(process.env.PER_KM_AFTER_BASE_AZN || 0.4),
    driverCommissionPct: Number(process.env.DRIVER_COMMISSION_PCT || 10),
    driverBlockLimit: Number(process.env.DRIVER_BLOCK_LIMIT_AZN || -15),
  },
};

if (!cfg.databaseUrl) {
  // Render sets DATABASE_URL automatically when you attach a PostgreSQL instance.
  console.warn('[WARN] DATABASE_URL is missing. Set it in your environment.');
}
