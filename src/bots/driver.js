import { Telegraf, Markup } from 'telegraf';
import { cfg } from '../config.js';
import { q } from '../db.js';
import {
  bumpDriverBalance,
  ensureDriverProfile,
  getDriverProfile,
  getUserByTgId,
  upsertUser,
} from '../utils/dbHelpers.js';
import { wazeLink } from '../utils/geo.js';

const mem = new Map(); // tgId -> {step, data}

function menu(profile) {
  return Markup.keyboard([
    ['🟢 Onlayn ol', '🔴 Oflayn ol'],
    ['💳 Balansım', '➕ Balans artır'],
    ['📄 Profilim', 'ℹ️ Kömək'],
  ]).resize();
}

function needReg(profile) {
  // If no car_make then not complete
  if (!profile) return true;
  return !profile.car_make || !profile.car_plate || !profile.doc_license_file_id;
}

export function buildDriverBot() {
  const bot = new Telegraf(cfg.driverBotToken);

  bot.start(async (ctx) => {
    await upsertUser({
      role: 'driver',
      tgId: ctx.from.id,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    });
    const u = await getUserByTgId(ctx.from.id);
    await ensureDriverProfile(u.id);
    const p = await getDriverProfile(u.id);

    if (needReg(p)) {
      mem.set(ctx.from.id, { step: 'phone', data: {} });
      return ctx.reply(
        '🚗 Sürücü qeydiyyatı\n\nZəhmət olmasa telefon nömrənizi göndərin (+994...)',
        Markup.keyboard([[Markup.button.contactRequest('📱 Nömrəni göndər')]]).resize()
      );
    }

    return ctx.reply('PayTaksi Sürücü paneli 🚖', menu(p));
  });

  bot.hears('ℹ️ Kömək', (ctx) =>
    ctx.reply('Onlayn olmaq üçün “🟢 Onlayn ol” seçin. Balansınız -15 AZN və aşağıdırsa sifariş ala bilməyəcəksiniz.')
  );

  bot.hears('💳 Balansım', async (ctx) => {
    const u = await getUserByTgId(ctx.from.id);
    if (!u) return ctx.reply('Zəhmət olmasa /start.');
    const p = await getDriverProfile(u.id);
    return ctx.reply(`Balans: ${Number(p.balance_azn).toFixed(2)} AZN`);
  });

  bot.hears('📄 Profilim', async (ctx) => {
    const u = await getUserByTgId(ctx.from.id);
    if (!u) return;
    const p = await getDriverProfile(u.id);
    const msg = [
      `Status: ${p.status}`,
      `Ad: ${u.first_name || ''} ${u.last_name || ''}`,
      `Telefon: ${u.phone || '-'}`,
      `Avto: ${p.car_make || '-'} ${p.car_model || ''}`,
      `Nomre: ${p.car_plate || '-'}`,
      `Balans: ${Number(p.balance_azn).toFixed(2)} AZN`,
    ].join('\n');
    return ctx.reply(msg);
  });

  bot.hears('🟢 Onlayn ol', async (ctx) => {
    const u = await getUserByTgId(ctx.from.id);
    if (!u) return;
    const p = await getDriverProfile(u.id);

    if (needReg(p)) return ctx.reply('Qeydiyyat tamamlanmayıb. /start yazın.');
    if (p.status !== 'approved') return ctx.reply('Hələ təsdiqlənməyibsiniz. Admin yoxlayır.');

    if (Number(p.balance_azn) <= cfg.pricing.driverBlockLimit) {
      return ctx.reply(
        `⛔ Balansınız çox mənfidir: ${Number(p.balance_azn).toFixed(2)} AZN\nSifariş ala bilməzsiniz.\n\nSəbəb: limit ${cfg.pricing.driverBlockLimit} AZN.`
      );
    }

    return ctx.reply(
      '📍 Onlayn oldunuz. Mövqeyinizi göndərin (Location) ki, naviqasiya linkləri düzgün olsun.',
      Markup.keyboard([[Markup.button.locationRequest('📍 Cari mövqeyimi göndər')], ['🔴 Oflayn ol']]).resize()
    );
  });

  bot.hears('🔴 Oflayn ol', async (ctx) => {
    return ctx.reply('Oflayn oldunuz.', menu(await getDriverProfile((await getUserByTgId(ctx.from.id))?.id)));
  });

  bot.hears('➕ Balans artır', async (ctx) => {
    const u = await getUserByTgId(ctx.from.id);
    if (!u) return;
    const p = await getDriverProfile(u.id);
    if (needReg(p)) return ctx.reply('Əvvəl qeydiyyatı tamamlayın. /start');

    mem.set(ctx.from.id, { step: 'topup_method', data: {} });
    return ctx.reply(
      'Balans artırma üsulunu seçin:',
      Markup.keyboard([['💳 Card2Card', '🏧 Terminal', '📲 M10'], ['❌ Ləğv et']]).resize()
    );
  });

  bot.hears('❌ Ləğv et', async (ctx) => {
    mem.delete(ctx.from.id);
    const u = await getUserByTgId(ctx.from.id);
    const p = u ? await getDriverProfile(u.id) : null;
    return ctx.reply('Ləğv edildi.', p ? menu(p) : undefined);
  });

  bot.hears(['💳 Card2Card', '🏧 Terminal', '📲 M10'], async (ctx) => {
    const st = mem.get(ctx.from.id);
    if (!st || st.step !== 'topup_method') return;
    const map = { '💳 Card2Card': 'card2card', '🏧 Terminal': 'terminal', '📲 M10': 'm10' };
    st.data.method = map[ctx.message.text];
    st.step = 'topup_amount';
    mem.set(ctx.from.id, st);
    return ctx.reply('Məbləği yazın (məs: 10):');
  });

  bot.on('text', async (ctx) => {
    const st = mem.get(ctx.from.id);
    if (!st) return;

    // Registration
    if (st.step === 'phone') {
      const txt = ctx.message.text;
      if (!txt.startsWith('+994')) return ctx.reply('Telefon +994 ilə başlamalıdır. Yenidən yazın.');
      st.data.phone = txt;
      st.step = 'car_make';
      mem.set(ctx.from.id, st);
      await upsertUser({ role: 'driver', tgId: ctx.from.id, firstName: ctx.from.first_name, lastName: ctx.from.last_name, phone: txt });
      return ctx.reply('Avtomobil markası (məs: Toyota):', Markup.removeKeyboard());
    }
    if (st.step === 'car_make') {
      st.data.car_make = ctx.message.text;
      st.step = 'car_model';
      mem.set(ctx.from.id, st);
      return ctx.reply('Avtomobil modeli (məs: Aqua 2017):');
    }
    if (st.step === 'car_model') {
      st.data.car_model = ctx.message.text;
      st.step = 'car_plate';
      mem.set(ctx.from.id, st);
      return ctx.reply('Avtomobil dövlət nömrəsi (məs: 90YX581):');
    }
    if (st.step === 'car_plate') {
      st.data.car_plate = ctx.message.text;
      st.step = 'car_color';
      mem.set(ctx.from.id, st);
      return ctx.reply('Avtomobil rəngi (məs: Ağ):');
    }
    if (st.step === 'car_color') {
      st.data.car_color = ctx.message.text;
      st.step = 'car_photo';
      mem.set(ctx.from.id, st);
      return ctx.reply('🚗 Avtomobilin şəklini göndərin (Photo).');
    }

    // Topup amount
    if (st.step === 'topup_amount') {
      const amt = Number(String(ctx.message.text).replace(',', '.'));
      if (!Number.isFinite(amt) || amt <= 0) return ctx.reply('Düzgün məbləğ yazın.');
      st.data.amount = amt;
      st.step = 'topup_receipt';
      mem.set(ctx.from.id, st);
      return ctx.reply('🧾 İndi qəbz şəklini göndərin (Photo).');
    }
  });

  bot.on('contact', async (ctx) => {
    const st = mem.get(ctx.from.id);
    if (!st || st.step !== 'phone') return;
    const phone = ctx.message.contact.phone_number;
    const p = phone.startsWith('+') ? phone : `+${phone}`;
    if (!p.startsWith('+994')) return ctx.reply('Telefon +994 ilə başlamalıdır.');
    st.data.phone = p;
    st.step = 'car_make';
    mem.set(ctx.from.id, st);
    await upsertUser({ role: 'driver', tgId: ctx.from.id, firstName: ctx.from.first_name, lastName: ctx.from.last_name, phone: p });
    return ctx.reply('Avtomobil markası (məs: Toyota):', Markup.removeKeyboard());
  });

  bot.on('photo', async (ctx) => {
    const st = mem.get(ctx.from.id);
    if (!st) return;
    const fileId = ctx.message.photo.at(-1).file_id;

    const u = await getUserByTgId(ctx.from.id);
    if (!u) return;

    if (st.step === 'car_photo') {
      st.data.car_photo_file_id = fileId;
      st.step = 'doc_id_front';
      mem.set(ctx.from.id, st);
      return ctx.reply('🪪 Şəxsiyyət vəsiqəsi (ÖN) şəklini göndərin.');
    }
    if (st.step === 'doc_id_front') {
      st.data.doc_id_front_file_id = fileId;
      st.step = 'doc_id_back';
      mem.set(ctx.from.id, st);
      return ctx.reply('🪪 Şəxsiyyət vəsiqəsi (ARXA) şəklini göndərin.');
    }
    if (st.step === 'doc_id_back') {
      st.data.doc_id_back_file_id = fileId;
      st.step = 'doc_license';
      mem.set(ctx.from.id, st);
      return ctx.reply('🚘 Sürücülük vəsiqəsi şəklini göndərin.');
    }
    if (st.step === 'doc_license') {
      st.data.doc_license_file_id = fileId;
      st.step = 'doc_reg_front';
      mem.set(ctx.from.id, st);
      return ctx.reply('📄 Texniki pasport (ÖN) şəklini göndərin.');
    }
    if (st.step === 'doc_reg_front') {
      st.data.doc_reg_front_file_id = fileId;
      st.step = 'doc_reg_back';
      mem.set(ctx.from.id, st);
      return ctx.reply('📄 Texniki pasport (ARXA) şəklini göndərin.');
    }
    if (st.step === 'doc_reg_back') {
      st.data.doc_reg_back_file_id = fileId;

      // Save profile
      await q(
        `UPDATE driver_profiles SET
          car_make=$2, car_model=$3, car_plate=$4, car_color=$5,
          car_photo_file_id=$6,
          doc_id_front_file_id=$7, doc_id_back_file_id=$8,
          doc_license_file_id=$9,
          doc_reg_front_file_id=$10, doc_reg_back_file_id=$11,
          status='pending', updated_at=NOW()
         WHERE user_id=$1`,
        [
          u.id,
          st.data.car_make,
          st.data.car_model,
          st.data.car_plate,
          st.data.car_color,
          st.data.car_photo_file_id,
          st.data.doc_id_front_file_id,
          st.data.doc_id_back_file_id,
          st.data.doc_license_file_id,
          st.data.doc_reg_front_file_id,
          st.data.doc_reg_back_file_id,
        ]
      );

      mem.delete(ctx.from.id);
      return ctx.reply(
        '✅ Qeydiyyat tamamlandı.\nAdmin təsdiqindən sonra sifariş ala biləcəksiniz.',
        menu(await getDriverProfile(u.id))
      );
    }

    // Topup receipt
    if (st.step === 'topup_receipt') {
      const method = st.data.method;
      const amount = st.data.amount;
      const rr = await q(
        `INSERT INTO topup_requests(driver_id,method,amount_azn,receipt_file_id,status)
         VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
        [u.id, method, amount, fileId]
      );
      mem.delete(ctx.from.id);
      return ctx.reply(`✅ Qəbz göndərildi. Sorğu ID: #${rr.rows[0].id}\nAdmin təsdiqləyəndən sonra balans artırılacaq.`, menu(await getDriverProfile(u.id)));
    }
  });

  // Ride actions callbacks handled by index (shared)

  bot.on('location', async (ctx) => {
    // store last location for navigation; no strict format needed
    // (future: live location)
    const u = await getUserByTgId(ctx.from.id);
    if (!u) return;
    await q(
      `INSERT INTO bot_state(key,value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [`driver_loc:${u.id}`, { lat: ctx.message.location.latitude, lng: ctx.message.location.longitude }]
    );
    return ctx.reply('✅ Mövqe yadda saxlanıldı. Sifariş gözlənilir...', menu(await getDriverProfile(u.id)));
  });

  // Expose helper to send ride offer
  bot.sendRideOffer = async function sendRideOffer(driverTgId, req) {
    const msg =
      `🚕 Yeni sifariş #${req.id}\n` +
      `Məsafə: ${Number(req.distance_km).toFixed(2)} km\n` +
      `Qiymət: ${Number(req.fare_azn).toFixed(2)} AZN\n\n` +
      `Qəbul edirsiniz?`;

    return bot.telegram.sendMessage(
      driverTgId,
      msg,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Qəbul et', `ride_accept:${req.id}`),
        Markup.button.callback('❌ Rədd et', `ride_reject:${req.id}`),
      ])
    );
  };

  bot.sendRideControls = async function sendRideControls(driverTgId, ride) {
    const txt =
      `✅ Sifariş qəbul edildi (#${ride.id})\n\n` +
      `Pickup: ${ride.pickup_text || ''}\n` +
      `Dest: ${ride.dest_text || ''}`;

    return bot.telegram.sendMessage(
      driverTgId,
      txt,
      Markup.inlineKeyboard([
        [Markup.button.callback('📍 Çatdım', `ride_arrived:${ride.id}`)],
        [Markup.button.callback('▶️ Gedişə başla', `ride_start:${ride.id}`)],
        [Markup.button.callback('⏹ Gedişi bitir', `ride_finish:${ride.id}`)],
        [Markup.button.callback('🚫 Ləğv et', `ride_cancel:${ride.id}`)],
      ])
    );
  };

  bot.sendWaze = async function sendWaze(driverTgId, lat, lng) {
    return bot.telegram.sendMessage(driverTgId, `🧭 Waze naviqasiya: ${wazeLink(lat, lng)}`);
  };

  bot.chargeCommission = async function chargeCommission(driverUserId, fare) {
    const commission = Math.round((Number(fare) * (cfg.pricing.driverCommissionPct / 100)) * 100) / 100;
    const next = await bumpDriverBalance(driverUserId, -commission, 'commission', { fare });
    return { commission, nextBalance: next };
  };

  return bot;
}
