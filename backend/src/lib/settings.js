import { prisma } from './prisma.js';

export const DEFAULT_SETTINGS = {
  COMMISSION_RATE: '0.10',
  BASE_FARE_AZN: '3.50',
  INCLUDED_KM: '3',
  PER_KM_AZN: '0.40',
  DRIVER_BLOCK_BALANCE: '-10',
  MIN_CAR_YEAR: '2010',
  ALLOWED_CAR_COLORS: 'aq,qara,qirmizi,boz,mavi,sari,yashil'
};

export async function ensureDefaultSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const exists = await prisma.setting.findUnique({ where: { key } });
    if (!exists) {
      await prisma.setting.create({ data: { key, value } });
    }
  }
}

export async function getSetting(key, fallback = null) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

export async function setSetting(key, value) {
  await prisma.setting.upsert({
    where: { key },
    update: { value: String(value) },
    create: { key, value: String(value) }
  });
}

export async function getPricing() {
  const base = parseFloat(await getSetting('BASE_FARE_AZN', DEFAULT_SETTINGS.BASE_FARE_AZN));
  const includedKm = parseFloat(await getSetting('INCLUDED_KM', DEFAULT_SETTINGS.INCLUDED_KM));
  const perKm = parseFloat(await getSetting('PER_KM_AZN', DEFAULT_SETTINGS.PER_KM_AZN));
  const commissionRate = parseFloat(await getSetting('COMMISSION_RATE', DEFAULT_SETTINGS.COMMISSION_RATE));
  const blockBal = parseFloat(await getSetting('DRIVER_BLOCK_BALANCE', DEFAULT_SETTINGS.DRIVER_BLOCK_BALANCE));
  const minCarYear = parseInt(await getSetting('MIN_CAR_YEAR', DEFAULT_SETTINGS.MIN_CAR_YEAR), 10);
  const allowedColors = String(await getSetting('ALLOWED_CAR_COLORS', DEFAULT_SETTINGS.ALLOWED_CAR_COLORS))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return { base, includedKm, perKm, commissionRate, blockBal, minCarYear, allowedColors };
}
