const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');

const COLORS = ['ağ','qara','qırmızı','sarı','göy','boz','mavi','yaşıl'];
const OPERATORS = ['Azercell','Bakcell','Nar','Naxtel','Digər'];

function normalizePhone(p) {
  const s = String(p || '').replace(/\s+/g, '');
  if (!s.startsWith('+994')) return null;
  if (!/^\+994\d{9}$/.test(s)) return null;
  return s;
}

async function findUserByTg(pool, tgId) {
  const r = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId]);
  return r.rows[0] || null;
}

async function ensureDriverUser(pool, tgId) {
  const u = await findUserByTg(pool, tgId);
  if (u) return u;
  const ins = await pool.query(
    "INSERT INTO users(telegram_id, role, created_at) VALUES($1,'driver',NOW()) RETURNING *",
    [tgId]
  );
  return ins.rows[0];
}

async function getDriverRow(pool, userId) {
  const r = await pool.query('SELECT * FROM drivers WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}

async function upsertDriver(pool, userId, patch) {
  const existing = await getDriverRow(pool, userId);
  if (!existing) {
    await pool.query(
      `INSERT INTO drivers(user_id, operator, car_make, car_model, car_color, docs_id_front_file_id, docs_id_back_file_id, docs_license_file_id, docs_car_file_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId,
        patch.operator || null,
        patch.car_make || null,
        patch.car_model || null,
        patch.car_color || null,
        patch.docs_id_front_file_id || null,
        patch.docs_id_back_file_id || null,
        patch.docs_license_file_id || null,
        patch.docs_car_file_id || null
      ]
    );
  } else {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    const set = fields.map((k, i) => `${k}=$${i + 2}`).join(', ');
    const vals = fields.map((k) => patch[k]);
    await pool.query(`UPDATE drivers SET ${set} WHERE user_id=$1`, [userId, ...vals]);
  }
}

function createDriverBot({ pool, getPassengerBot }) {
  const token = process.env.DRIVER_BOT_TOKEN;
  if (!token) throw new Error('DRIVER_BOT_TOKEN missing');
  const bot = new Telegraf(token);

  bot.use(new LocalSession({ database: 'driver_sessions.json' }).middleware());

  bot.start(async (ctx) => {
    const tgId = ctx.from.id;
    const user = await ensureDriverUser(pool, tgId);
    const driver = await getDriverRow(pool, user.id);

    const panelUrl = `${process.env.APP_BASE_URL}/d/?tg_id=${tgId}`;

    if (!driver) {
      ctx.session.reg = { step: 'first_name', data: {} };
      return ctx.reply('👋 Sürücü qeydiyyatı başlayır.\n\nAdınızı yazın:');
    }

    if (driver.status !== 'approved') {
      return ctx.reply(`⏳ Status: ${driver.status}.\nAdmin təsdiqi gözlənilir.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Paneli aç', web_app: { url: panelUrl } }]] }
      });
    }

    return ctx.reply('✅ Sürücü paneli:', {
      reply_markup: {
        keyboard: [[{ text: '🚗 Sürücü Paneli', web_app: { url: panelUrl } }]],
        resize_keyboard: true
      }
    });
  });

  bot.command('panel', async (ctx) => {
    const tgId = ctx.from.id;
    const panelUrl = `${process.env.APP_BASE_URL}/d/?tg_id=${tgId}`;
    await ctx.reply('Panel açılır:', { reply_markup: { inline_keyboard: [[{ text: 'Paneli aç', web_app: { url: panelUrl } }]] } });
  });

  // Registration wizard (text)
  bot.on('text', async (ctx) => {
    const reg = ctx.session.reg;
    if (!reg) return;
    const text = (ctx.message.text || '').trim();

    if (reg.step === 'first_name') {
      reg.data.first_name = text;
      reg.step = 'last_name';
      return ctx.reply('Soyadınızı yazın:');
    }

    if (reg.step === 'last_name') {
      reg.data.last_name = text;
      reg.step = 'phone';
      return ctx.reply('Telefon nömrənizi yazın (mütləq +994 ilə):\nMəs: +994501234567');
    }

    if (reg.step === 'phone') {
      const phone = normalizePhone(text);
      if (!phone) return ctx.reply('❌ Nömrə düzgün deyil. +994 ilə yazın və 9 rəqəm olsun.\nMəs: +994501234567');
      reg.data.phone_e164 = phone;
      reg.step = 'operator';
      return ctx.reply('Operator seçin:', Markup.keyboard(OPERATORS.map((x) => [x])).resize());
    }

    if (reg.step === 'operator') {
      if (!OPERATORS.includes(text)) return ctx.reply('Operatoru klaviaturadan seçin.');
      reg.data.operator = text;
      reg.step = 'car_make';
      return ctx.reply('Avtomobil markası (məs: Toyota):', Markup.removeKeyboard());
    }

    if (reg.step === 'car_make') {
      reg.data.car_make = text;
      reg.step = 'car_model';
      return ctx.reply('Avtomobil modeli (məs: Aqua 2017):');
    }

    if (reg.step === 'car_model') {
      reg.data.car_model = text;
      reg.step = 'car_color';
      return ctx.reply('Rəng seçin:', Markup.keyboard(COLORS.map((x) => [x])).resize());
    }

    if (reg.step === 'car_color') {
      if (!COLORS.includes(text)) return ctx.reply('Rəngi klaviaturadan seçin.');
      reg.data.car_color = text;
      reg.step = 'doc_id_front';
      await ctx.reply('Şəxsiyyət vəsiqəsinin ÖN şəkilini göndərin (foto):', Markup.removeKeyboard());
      return;
    }

    // any other step expects photo
  });

  // Photo steps
  bot.on('photo', async (ctx) => {
    const reg = ctx.session.reg;
    if (!reg) return;
    const step = reg.step;
    const photos = ctx.message.photo || [];
    const fileId = photos[photos.length - 1]?.file_id;
    if (!fileId) return;

    if (step === 'doc_id_front') {
      reg.data.docs_id_front_file_id = fileId;
      reg.step = 'doc_id_back';
      return ctx.reply('Şəxsiyyət vəsiqəsinin ARXA şəkilini göndərin (foto):');
    }

    if (step === 'doc_id_back') {
      reg.data.docs_id_back_file_id = fileId;
      reg.step = 'doc_license';
      return ctx.reply('Sürücülük vəsiqəsini göndərin (foto):');
    }

    if (step === 'doc_license') {
      reg.data.docs_license_file_id = fileId;
      reg.step = 'doc_car';
      return ctx.reply('Avtomobil sənədini göndərin (foto):');
    }

    if (step === 'doc_car') {
      reg.data.docs_car_file_id = fileId;
      // Save all
      const tgId = ctx.from.id;
      const user = await ensureDriverUser(pool, tgId);

      await pool.query('UPDATE users SET first_name=$2, last_name=$3, phone_e164=$4 WHERE id=$1', [
        user.id,
        reg.data.first_name,
        reg.data.last_name,
        reg.data.phone_e164
      ]);

      await upsertDriver(pool, user.id, {
        operator: reg.data.operator,
        car_make: reg.data.car_make,
        car_model: reg.data.car_model,
        car_color: reg.data.car_color,
        docs_id_front_file_id: reg.data.docs_id_front_file_id,
        docs_id_back_file_id: reg.data.docs_id_back_file_id,
        docs_license_file_id: reg.data.docs_license_file_id,
        docs_car_file_id: reg.data.docs_car_file_id
      });

      ctx.session.reg = null;

      // Notify admin
      const adminId = Number(process.env.SUPER_ADMIN_ID);
      try {
        await bot.telegram.sendMessage(adminId, `🆕 Yeni sürücü qeydiyyatı\n\n👤 ${reg.data.first_name} ${reg.data.last_name}\n📞 ${reg.data.phone_e164}\n🚗 ${reg.data.car_make} ${reg.data.car_model} (${reg.data.car_color})\n\nAdmin paneldən təsdiqlə.`);
      } catch (e) {}

      return ctx.reply('✅ Qeydiyyat tamamlandı!\n⏳ Admin təsdiqi gözlənilir.');
    }
  });

  // Offer callbacks
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    const tgId = ctx.from.id;
    const user = await ensureDriverUser(pool, tgId);
    const driver = await getDriverRow(pool, user.id);

    if (!driver || driver.status !== 'approved') {
      await ctx.answerCbQuery('Siz təsdiqli sürücü deyilsiniz.');
      return;
    }

    if (data.startsWith('accept:')) {
      const rideId = data.split(':')[1];
      const r = await pool.query('SELECT * FROM rides WHERE id=$1', [rideId]);
      const ride = r.rows[0];
      if (!ride) {
        await ctx.answerCbQuery('Sifariş tapılmadı');
        return;
      }
      if (ride.status === 'accepted' && ride.driver_user_id && Number(ride.driver_user_id) !== Number(user.id)) {
        await ctx.answerCbQuery('Bu sifariş artıq götürülüb');
        return;
      }

      // accept
      await pool.query('UPDATE rides SET status=$2, driver_user_id=$3, accepted_at=NOW() WHERE id=$1', [rideId, 'accepted', user.id]);
      await pool.query("UPDATE ride_offers SET status='accepted', responded_at=NOW() WHERE ride_id=$1 AND driver_user_id=$2", [rideId, user.id]);
      await pool.query("UPDATE ride_offers SET status='expired', responded_at=NOW() WHERE ride_id=$1 AND driver_user_id<>$2 AND status='offered'", [rideId, user.id]);

      await ctx.answerCbQuery('Qəbul edildi');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Qəbul edildi', callback_data: 'noop' }]] });

      // Notify passenger via passenger bot
      try {
        const passengerBot = getPassengerBot();
        const pu = await pool.query('SELECT telegram_id FROM users WHERE id=$1', [ride.passenger_user_id]);
        const passengerTg = pu.rows[0]?.telegram_id;
        if (passengerTg) {
          await passengerBot.telegram.sendMessage(Number(passengerTg), `✅ Sifarişiniz qəbul edildi!\nSürücü: ${ctx.from.first_name || ''}`);
        }
      } catch (e) {}

      return;
    }

    if (data.startsWith('reject:')) {
      const rideId = data.split(':')[1];
      await pool.query("UPDATE ride_offers SET status='rejected', responded_at=NOW() WHERE ride_id=$1 AND driver_user_id=$2", [rideId, user.id]);
      await ctx.answerCbQuery('Rədd edildi');
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✖️ Rədd edildi', callback_data: 'noop' }]] }); } catch (e) {}
      return;
    }

    await ctx.answerCbQuery();
  });

  bot.catch((err) => console.error('Driver bot error', err));
  return bot;
}

module.exports = { createDriverBot };
