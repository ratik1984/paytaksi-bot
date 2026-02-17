import { Telegraf, Markup } from 'telegraf';
import { q } from '../db.js';
import { driverFlow } from '../state.js';
import { azPhoneNormalize, money2, mdBoldBig } from '../utils.js';
import { routeDistanceKm } from '../osrm.js';
import { calcFare, calcCommission } from '../fare.js';

async function getDriver(tgUserId) {
  const res = await q('SELECT * FROM drivers WHERE tg_user_id=$1', [tgUserId]);
  return res.rowCount ? res.rows[0] : null;
}

async function createDriver(tgUser, data) {
  const res = await q(
    `INSERT INTO drivers (
      tg_user_id, first_name, last_name, phone,
      car_brand, car_model, car_plate,
      car_photo_file_id,
      doc_driver_license_file_id,
      doc_id_front_file_id,
      doc_id_back_file_id,
      doc_car_passport_front_file_id,
      doc_car_passport_back_file_id,
      status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
    RETURNING *`,
    [
      tgUser.id,
      data.first_name,
      data.last_name,
      data.phone,
      data.car_brand,
      data.car_model,
      data.car_plate,
      data.car_photo_file_id,
      data.doc_driver_license_file_id,
      data.doc_id_front_file_id,
      data.doc_id_back_file_id,
      data.doc_car_passport_front_file_id,
      data.doc_car_passport_back_file_id,
    ]
  );
  return res.rows[0];
}

async function setDriverOnline(driverId, online) {
  await q('UPDATE drivers SET online=$1, last_seen=NOW() WHERE id=$2', [online, driverId]);
}

async function updateDriverLocation(driverId, lat, lon) {
  await q('UPDATE drivers SET last_lat=$1, last_lon=$2, last_seen=NOW() WHERE id=$3', [lat, lon, driverId]);
}

async function setDriverBusy(driverId, busy) {
  await q('UPDATE drivers SET busy=$1 WHERE id=$2', [busy, driverId]);
}

async function getRideById(id) {
  const res = await q(
    `SELECT r.*, d.tg_user_id AS driver_tg, p.tg_user_id AS passenger_tg,
            d.first_name AS d_first, d.last_name AS d_last, d.car_brand, d.car_model, d.car_plate,
            p.first_name AS p_first, p.last_name AS p_last
     FROM rides r
     JOIN drivers d ON d.id=r.driver_id
     JOIN passengers p ON p.id=r.passenger_id
     WHERE r.id=$1`,
    [id]
  );
  return res.rowCount ? res.rows[0] : null;
}

export function buildDriverBot(passengerBotApi) {
  const token = process.env.DRIVER_BOT_TOKEN;
  if (!token) throw new Error('DRIVER_BOT_TOKEN missing');
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const d = await getDriver(ctx.from.id);
    if (d) {
      const status = d.status;
      const onlineText = d.online ? 'ONLAYN ✅' : 'OFFLAYN ⛔';
      await ctx.reply(
        `Salam, ${d.first_name || 'Sürücü'}!\nStatus: ${status}\nRejim: ${onlineText}\nBalans: ${money2(d.balance)} ₼\n\n/online - Onlayn ol\n/offline - Oflayn ol\n/balance - Balans\n/topup - Balans artır (qəbz yüklə)\n/help`
      );
      return;
    }

    driverFlow.set(ctx.from.id, { step: 'first_name', data: {} });
    await ctx.reply('PayTaksi Sürücü qeydiyyatı: Adınızı yazın:');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply('Komandalar:\n/online - onlayn ol\n/offline - oflayn ol\n/location - cari yerini göndər\n/balance - balans\n/topup - balans artır (qəbz)');
  });

  bot.command('balance', async (ctx) => {
    const d = await getDriver(ctx.from.id);
    if (!d) return ctx.reply('Sürücü profili yoxdur. /start');
    const blockLimit = Number(process.env.DRIVER_BALANCE_BLOCK_LIMIT || -15);
    let extra = '';
    if (Number(d.balance) <= blockLimit) {
      extra = `\n\n⚠️ Balansınız ${money2(d.balance)} ₼ olduğu üçün sifariş qəbul edə bilmirsiniz. Limit: ${money2(blockLimit)} ₼`;
    }
    await ctx.reply(`Balans: ${money2(d.balance)} ₼${extra}`);
  });

  bot.command('online', async (ctx) => {
    const d = await getDriver(ctx.from.id);
    if (!d) return ctx.reply('Sürücü profili yoxdur. /start');
    if (d.status !== 'active') return ctx.reply('Hesabınız hələ aktiv deyil (admin təsdiqi gözləyir).');

    const blockLimit = Number(process.env.DRIVER_BALANCE_BLOCK_LIMIT || -15);
    if (Number(d.balance) <= blockLimit) {
      return ctx.reply(`⚠️ Balans limitdən aşağıdır (${money2(d.balance)} ₼). Onlayn ola bilməzsiniz.\nSəbəb: balans ${money2(blockLimit)} ₼-dən aşağıdır.`);
    }

    await setDriverOnline(d.id, true);
    await ctx.reply(
      'Onlayn oldunuz ✅\nXəritədə görünmək üçün yerinizi göndərin:',
      Markup.keyboard([[Markup.button.locationRequest('📍 Yerimi göndər')]]).oneTime().resize()
    );
  });

  bot.command('offline', async (ctx) => {
    const d = await getDriver(ctx.from.id);
    if (!d) return ctx.reply('Sürücü profili yoxdur. /start');
    await setDriverOnline(d.id, false);
    await ctx.reply('Oflayn oldunuz ⛔', Markup.removeKeyboard());
  });

  bot.command('location', async (ctx) => {
    await ctx.reply('Yer göndərmək üçün aşağıdakı düyməni basın:', Markup.keyboard([[Markup.button.locationRequest('📍 Yerimi göndər')]]).oneTime().resize());
  });

  bot.on('location', async (ctx) => {
    const d = await getDriver(ctx.from.id);
    if (!d) return;
    const loc = ctx.message.location;
    await updateDriverLocation(d.id, loc.latitude, loc.longitude);
    await ctx.reply(`Yer yeniləndi ✅ (${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)})`, Markup.removeKeyboard());
  });

  // Top-up flow
  bot.command('topup', async (ctx) => {
    const d = await getDriver(ctx.from.id);
    if (!d) return ctx.reply('Sürücü profili yoxdur. /start');
    driverFlow.set(ctx.from.id, { step: 'topup_amount', data: {} });
    await ctx.reply('Balans artırma: məbləği yazın (məs: 10.00):');
  });

  bot.on('photo', async (ctx) => {
    const flow = driverFlow.get(ctx.from.id);
    if (!flow) return;

    // registration documents and car photo
    const photos = ctx.message.photo;
    const best = photos?.[photos.length - 1];
    const fileId = best?.file_id;

    if (flow.step?.startsWith('reg_') && fileId) {
      flow.data[flow.step.replace('reg_', '')] = fileId;
      const next = nextRegStep(flow.step);
      if (!next) {
        const created = await createDriver(ctx.from, flow.data);
        driverFlow.delete(ctx.from.id);
        await ctx.reply('Qeydiyyat tamamlandı ✅\nHesabınız admin tərəfindən təsdiqlənəndən sonra aktiv olacaq.');
        return;
      }
      flow.step = next;
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply(regStepPrompt(next));
    }

    if (flow.step === 'topup_receipt' && fileId) {
      const d = await getDriver(ctx.from.id);
      if (!d) return;
      const amount = Number(flow.data.amount_azn);
      const method = flow.data.method || 'other';

      await q(
        'INSERT INTO topup_requests (driver_id, amount_azn, method, receipt_file_id, status) VALUES ($1,$2,$3,$4,\'pending\')',
        [d.id, amount, method, fileId]
      );

      driverFlow.delete(ctx.from.id);
      await ctx.reply('Qəbz göndərildi ✅ Admin yoxlayandan sonra balansınıza əlavə ediləcək.');
      return;
    }
  });

  bot.on('text', async (ctx) => {
    const d = await getDriver(ctx.from.id);
    const flow = driverFlow.get(ctx.from.id);
    const text = (ctx.message.text || '').trim();

    if (!flow) return;

    // Registration
    if (flow.step === 'first_name') {
      flow.data.first_name = text;
      flow.step = 'last_name';
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply('Soyadınızı yazın:');
    }
    if (flow.step === 'last_name') {
      flow.data.last_name = text;
      flow.step = 'phone';
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply('Telefon nömrəniz: +994XXXXXXXXX');
    }
    if (flow.step === 'phone') {
      const phone = azPhoneNormalize(text);
      if (!phone) return ctx.reply('Format səhvdir. Məs: +994501234567');
      flow.data.phone = phone;
      flow.step = 'car_brand';
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply('Avtomobil markası (məs: Toyota):');
    }
    if (flow.step === 'car_brand') {
      flow.data.car_brand = text;
      flow.step = 'car_model';
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply('Avtomobil modeli (məs: Aqua 2017):');
    }
    if (flow.step === 'car_model') {
      flow.data.car_model = text;
      flow.step = 'car_plate';
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply('Avtomobil nömrəsi (məs: 90-XX-581):');
    }
    if (flow.step === 'car_plate') {
      flow.data.car_plate = text;
      flow.step = 'reg_car_photo_file_id';
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply('Avtomobil şəkli göndərin (foto):');
    }

    // Topup
    if (flow.step === 'topup_amount') {
      const amount = Number(text.replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Məbləğ düzgün deyil. Məs: 10.00');
      flow.data.amount_azn = amount.toFixed(2);
      flow.step = 'topup_method';
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply(
        'Ödəniş üsulu seçin:',
        Markup.keyboard([
          ['Kart-to-Kart', 'Terminal'],
          ['M10', 'Digər'],
        ]).oneTime().resize()
      );
    }

    if (flow.step === 'topup_method') {
      const t = text.toLowerCase();
      let method = 'other';
      if (t.includes('kart')) method = 'card_to_card';
      else if (t.includes('terminal')) method = 'terminal';
      else if (t.includes('m10')) method = 'm10';
      flow.data.method = method;
      flow.step = 'topup_receipt';
      driverFlow.set(ctx.from.id, flow);
      return ctx.reply('İndi qəbzin şəklini göndərin (foto):', Markup.removeKeyboard());
    }
  });

  // Callbacks for accepting/rejecting rides
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery?.data || '';
    const d = await getDriver(ctx.from.id);
    if (!d) return ctx.answerCbQuery('Profil yoxdur');

    if (data.startsWith('accept:')) {
      const rideId = Number(data.split(':')[1]);
      const ride = await getRideById(rideId);
      if (!ride || ride.status !== 'requested') return ctx.answerCbQuery('Sifariş artıq mövcud deyil');
      if (ride.driver_id !== d.id) return ctx.answerCbQuery('Bu sifariş sizə aid deyil');

      const blockLimit = Number(process.env.DRIVER_BALANCE_BLOCK_LIMIT || -15);
      if (Number(d.balance) <= blockLimit) {
        await ctx.answerCbQuery('Balans limitdən aşağıdır');
        return ctx.reply(`⚠️ Balansınız ${money2(d.balance)} ₼. Limit: ${money2(blockLimit)} ₼. Sifariş qəbul etmək üçün balans artırın.`);
      }

      await q("UPDATE rides SET status='accepted', accepted_at=NOW() WHERE id=$1", [rideId]);
      await setDriverBusy(d.id, true);

      await passengerBotApi.sendMessage(
        ride.passenger_tg,
        `✅ Sifarişiniz qəbul edildi (#${rideId}).\nSürücü: ${ride.d_first || ''} ${ride.d_last || ''}\nAvto: ${ride.car_brand || ''} ${ride.car_model || ''} (${ride.car_plate || ''})`
      );

      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      await ctx.reply(
        `Sifariş #${rideId} qəbul edildi ✅\n\nKomandalar:\n/arrived_${rideId} - pickup-a çatdım\n/start_${rideId} - gedişə başladım\n/finish_${rideId} - gedişi bitir`,
        Markup.removeKeyboard()
      );
      return ctx.answerCbQuery('Qəbul edildi');
    }

    if (data.startsWith('reject:')) {
      const rideId = Number(data.split(':')[1]);
      const ride = await getRideById(rideId);
      if (!ride || ride.status !== 'requested') return ctx.answerCbQuery('Yoxdur');
      if (ride.driver_id !== d.id) return ctx.answerCbQuery('Aid deyil');

      await q("UPDATE rides SET status='cancelled' WHERE id=$1", [rideId]);
      await passengerBotApi.sendMessage(ride.passenger_tg, `❌ Sifariş rədd edildi (#${rideId}). Yenidən /ride edin.`);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      return ctx.answerCbQuery('Rədd edildi');
    }
  });

  // Ride stage commands: /arrived_ID /start_ID /finish_ID
  bot.hears(/^\/(arrived|start|finish)_(\d+)$/i, async (ctx) => {
    const action = ctx.match[1].toLowerCase();
    const rideId = Number(ctx.match[2]);
    const d = await getDriver(ctx.from.id);
    if (!d) return;
    const ride = await getRideById(rideId);
    if (!ride || ride.driver_id !== d.id) return ctx.reply('Sifariş tapılmadı.');

    if (action === 'arrived') {
      if (ride.status !== 'accepted') return ctx.reply('Bu mərhələ uyğun deyil.');
      await q("UPDATE rides SET status='arrived' WHERE id=$1", [rideId]);
      await passengerBotApi.sendMessage(ride.passenger_tg, `📍 Sürücü pickup-a çatdı (#${rideId}).`);
      return ctx.reply('Qeyd olundu: çatdınız ✅');
    }

    if (action === 'start') {
      if (!['accepted', 'arrived'].includes(ride.status)) return ctx.reply('Bu mərhələ uyğun deyil.');
      await q("UPDATE rides SET status='started', started_at=NOW() WHERE id=$1", [rideId]);
      await passengerBotApi.sendMessage(ride.passenger_tg, `🚕 Gediş başladı (#${rideId}).`);
      return ctx.reply('Gediş başladı ✅');
    }

    if (action === 'finish') {
      if (ride.status !== 'started') return ctx.reply('Bu mərhələ uyğun deyil.');

      // Calculate distance via OSRM
      const distanceKm = await routeDistanceKm(
        { lat: ride.pickup_lat, lon: ride.pickup_lon },
        { lat: ride.drop_lat, lon: ride.drop_lon }
      ).catch(() => null);

      const dKm = distanceKm ?? 0;
      const fare = calcFare(dKm);
      const commission = calcCommission(fare);

      await q(
        `UPDATE rides SET status='finished', finished_at=NOW(), distance_km=$2, fare_azn=$3, commission_azn=$4 WHERE id=$1`,
        [rideId, dKm, fare, commission]
      );

      // Deduct commission from driver balance
      await q('UPDATE drivers SET balance = balance - $1, busy=false WHERE id=$2', [commission, d.id]);
      await q(
        "INSERT INTO balance_ledger (driver_id, kind, amount_azn, ref_table, ref_id, note) VALUES ($1,'commission',$2,'rides',$3,$4)",
        [d.id, -commission, rideId, `Komissiya 10% (sifariş #${rideId})`]
      );

      const payText = `${money2(fare)} ₼`;
      await ctx.reply(
        `${mdBoldBig('MÜŞTƏRİDƏN ALINACAQ:')}\n${mdBoldBig(payText)}\n\nMəsafə: ${dKm.toFixed(2)} km\nKomissiya: ${money2(commission)} ₼`,
        { parse_mode: 'Markdown' }
      );

      await passengerBotApi.sendMessage(
        ride.passenger_tg,
        `✅ Gediş bitdi (#${rideId}). Ödəyəcəyiniz məbləğ: *${payText}*`,
        { parse_mode: 'Markdown' }
      );

      // If balance fell below limit, force offline
      const updated = await getDriver(ctx.from.id);
      const blockLimit = Number(process.env.DRIVER_BALANCE_BLOCK_LIMIT || -15);
      if (Number(updated.balance) <= blockLimit) {
        await setDriverOnline(updated.id, false);
        await ctx.reply(`⚠️ Balansınız limitdən aşağı düşdü (${money2(updated.balance)} ₼). Sistem sizi oflayn etdi.`);
      }

      return;
    }
  });

  return bot;
}

function nextRegStep(step) {
  const order = [
    'reg_car_photo_file_id',
    'reg_doc_driver_license_file_id',
    'reg_doc_id_front_file_id',
    'reg_doc_id_back_file_id',
    'reg_doc_car_passport_front_file_id',
    'reg_doc_car_passport_back_file_id',
  ];
  const i = order.indexOf(step);
  if (i === -1) return null;
  return order[i + 1] || null;
}

function regStepPrompt(step) {
  switch (step) {
    case 'reg_car_photo_file_id':
      return 'Avtomobil şəkli göndərin (foto):';
    case 'reg_doc_driver_license_file_id':
      return 'Sürücülük vəsiqəsinin şəklini göndərin (foto):';
    case 'reg_doc_id_front_file_id':
      return 'Şəxsiyyət vəsiqəsi (ön) şəkli göndərin (foto):';
    case 'reg_doc_id_back_file_id':
      return 'Şəxsiyyət vəsiqəsi (arxa) şəkli göndərin (foto):';
    case 'reg_doc_car_passport_front_file_id':
      return 'Avtomobil texniki pasportu (ön) şəkli göndərin (foto):';
    case 'reg_doc_car_passport_back_file_id':
      return 'Avtomobil texniki pasportu (arxa) şəkli göndərin (foto):';
    default:
      return 'Foto göndərin:';
  }
}
