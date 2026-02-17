import { Telegraf, Markup } from 'telegraf';
import { cfg } from '../config.js';
import { q } from '../db.js';
import { haversineKm } from '../utils/geo.js';
import { calcFare } from '../utils/pricing.js';
import { ensurePassengerProfile, getUserByTgId, upsertUser } from '../utils/dbHelpers.js';

const mem = new Map(); // tgId -> {step, data}

function mainMenu() {
  return Markup.keyboard([
    ['🚕 Taksi sifariş et'],
    ['🧾 Sifarişlərim', 'ℹ️ Kömək'],
  ]).resize();
}

export function buildPassengerBot({ onNewRideRequest }) {
  const bot = new Telegraf(cfg.passengerBotToken);

  bot.start(async (ctx) => {
    await upsertUser({
      role: 'passenger',
      tgId: ctx.from.id,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    });
    const u = await getUserByTgId(ctx.from.id);
    await ensurePassengerProfile(u.id);

    return ctx.reply(
      'PayTaksi 🚕\n\nXoş gəldiniz! Aşağıdan seçim edin.',
      mainMenu()
    );
  });

  bot.hears('ℹ️ Kömək', (ctx) =>
    ctx.reply(
      'Sifariş vermək üçün “🚕 Taksi sifariş et” seçin.\nGPS məkanınızı (location) göndərəcəksiniz: əvvəl “Götürmə”, sonra “Təyinat”.'
    )
  );

  bot.hears('🧾 Sifarişlərim', async (ctx) => {
    const u = await getUserByTgId(ctx.from.id);
    if (!u) return ctx.reply('Zəhmət olmasa /start yazın.');
    const r = await q(
      `SELECT id,status,fare_azn,created_at FROM ride_requests
       WHERE passenger_id=$1
       ORDER BY id DESC LIMIT 10`,
      [u.id]
    );
    if (!r.rows.length) return ctx.reply('Hələ sifariş yoxdur.');
    const lines = r.rows.map(
      (x) => `#${x.id} • ${x.status} • ${x.fare_azn ?? '-'} AZN • ${new Date(x.created_at).toLocaleString()}`
    );
    return ctx.reply(lines.join('\n'));
  });

  bot.hears('🚕 Taksi sifariş et', async (ctx) => {
    const u = await getUserByTgId(ctx.from.id);
    if (!u) return ctx.reply('Zəhmət olmasa /start yazın.');

    mem.set(ctx.from.id, { step: 'pickup', data: {} });
    return ctx.reply(
      '📍 Götürmə ünvanını göndərin (Location).',
      Markup.keyboard([[Markup.button.locationRequest('📍 Götürmə ünvanını göndər')], ['❌ Ləğv et']]).resize()
    );
  });

  bot.hears('❌ Ləğv et', (ctx) => {
    mem.delete(ctx.from.id);
    return ctx.reply('Ləğv edildi.', mainMenu());
  });

  bot.on('location', async (ctx) => {
    const st = mem.get(ctx.from.id);
    if (!st) return;

    const { latitude, longitude } = ctx.message.location;

    if (st.step === 'pickup') {
      st.data.pickup = { lat: latitude, lng: longitude };
      st.step = 'dest';
      mem.set(ctx.from.id, st);
      return ctx.reply(
        '🎯 İndi təyinat ünvanını göndərin (Location).',
        Markup.keyboard([[Markup.button.locationRequest('🎯 Təyinat ünvanını göndər')], ['❌ Ləğv et']]).resize()
      );
    }

    if (st.step === 'dest') {
      st.data.dest = { lat: latitude, lng: longitude };

      const dist = haversineKm(st.data.pickup, st.data.dest);
      const fare = calcFare(dist, cfg.pricing);

      const u = await getUserByTgId(ctx.from.id);

      const rr = await q(
        `INSERT INTO ride_requests(
           passenger_id,status,
           pickup_lat,pickup_lng,dest_lat,dest_lng,
           distance_km,fare_azn
         ) VALUES ($1,'searching',$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [u.id, st.data.pickup.lat, st.data.pickup.lng, st.data.dest.lat, st.data.dest.lng, dist, fare]
      );

      mem.delete(ctx.from.id);

      await ctx.reply(
        `✅ Sifariş yaradıldı: #${rr.rows[0].id}\nMəsafə: ${dist.toFixed(2)} km\nQiymət: ${fare.toFixed(2)} AZN\n\nSürücü axtarılır...`,
        mainMenu()
      );

      if (onNewRideRequest) await onNewRideRequest(rr.rows[0], ctx);
    }
  });

  return bot;
}
