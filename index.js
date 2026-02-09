require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN tapılmadı. .env faylını doldur (BOT_TOKEN=...).');
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(x => Number(x));

const OFFER_TIMEOUT_SEC = Number(process.env.OFFER_TIMEOUT_SEC || 25);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---- Persist (sadə JSON) ----
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {
      users: {},
      driversOnline: {},
      orders: {},
      orderSeq: 1
    };
  }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// ---- Helpers ----
function isAdmin(chatId) {
  return ADMIN_IDS.includes(Number(chatId));
}

function upsertUser(msg) {
  const chatId = String(msg.chat.id);
  data.users[chatId] = data.users[chatId] || {};
  data.users[chatId].id = Number(chatId);
  data.users[chatId].first_name = msg.from?.first_name || '';
  data.users[chatId].last_name = msg.from?.last_name || '';
  data.users[chatId].username = msg.from?.username || '';
  saveData();
}

function mainMenuKeyboard(chatId) {
  const rows = [
    [
      { text: '🚖 Sərnişin', callback_data: 'role:passenger' },
      { text: '🧑‍✈️ Sürücü', callback_data: 'role:driver' }
    ]
  ];
  if (isAdmin(chatId)) rows.push([{ text: '🛠 Admin', callback_data: 'role:admin' }]);

  return {
    reply_markup: {
      inline_keyboard: rows
    }
  };
}

function passengerMenu() {
  return {
    reply_markup: {
      keyboard: [
        ['🚖 Taksi sifariş et'],
        ['📍 Ünvanı yaz', '📌 Lokasiya göndər'],
        ['ℹ️ Kömək', '⬅️ Geri']
      ],
      resize_keyboard: true
    }
  };
}

function driverMenu(isOnline) {
  return {
    reply_markup: {
      keyboard: [
        [isOnline ? '🟢 Onlaynam' : '🟢 Onlayn ol', '🔴 Offlayn ol'],
        ['📥 Gələn offerlər', 'ℹ️ Kömək'],
        ['⬅️ Geri']
      ],
      resize_keyboard: true
    }
  };
}

function adminMenu() {
  return {
    reply_markup: {
      keyboard: [
        ['📊 Statistika'],
        ['📣 Broadcast'],
        ['⬅️ Geri']
      ],
      resize_keyboard: true
    }
  };
}

function setRole(chatId, role) {
  const id = String(chatId);
  data.users[id] = data.users[id] || {};
  data.users[id].role = role;
  data.users[id].step = null;
  saveData();
}

function getUser(chatId) {
  return data.users[String(chatId)] || {};
}

function setStep(chatId, step) {
  const id = String(chatId);
  data.users[id] = data.users[id] || {};
  data.users[id].step = step;
  saveData();
}

function newOrder(passengerId) {
  const orderId = String(data.orderSeq++);
  data.orders[orderId] = {
    id: orderId,
    passengerId: Number(passengerId),
    status: 'draft',
    pickup: null,
    dropoff: null,
    createdAt: Date.now(),
    offeredTo: [],
    acceptedBy: null
  };
  saveData();
  return data.orders[orderId];
}

function getActiveOrderByPassenger(passengerId) {
  const pid = Number(passengerId);
  const orders = Object.values(data.orders);
  return orders
    .filter(o => o.passengerId === pid && ['draft', 'searching'].includes(o.status))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function listOnlineDrivers() {
  return Object.keys(data.driversOnline)
    .filter(id => data.driversOnline[id] && data.driversOnline[id].online)
    .map(id => Number(id));
}

async function sendOffer(order, driverId) {
  const offerId = `offer:${order.id}:${driverId}:${Date.now()}`;
  const text =
    `🚕 *Yeni sifariş!*\n` +
    `Sifariş #${order.id}\n\n` +
    `📍 Pickup: ${formatPlace(order.pickup)}\n` +
    `🏁 Dropoff: ${formatPlace(order.dropoff)}\n\n` +
    `⏳ ${OFFER_TIMEOUT_SEC} saniyə ərzində qəbul et.`;

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Qəbul et', callback_data: `accept:${order.id}` },
          { text: '❌ Rədd et', callback_data: `reject:${order.id}` }
        ]
      ]
    },
    parse_mode: 'Markdown'
  };

  try {
    await bot.sendMessage(driverId, text, kb);
    order.offeredTo.push(driverId);
    order.status = 'searching';
    saveData();

    // Timeout: auto re-dispatch
    setTimeout(() => {
      const fresh = data.orders[String(order.id)];
      if (!fresh) return;
      if (fresh.status !== 'searching') return;
      if (fresh.acceptedBy) return;

      // if still not accepted by this driver, try next
      dispatchNextDriver(fresh);
    }, OFFER_TIMEOUT_SEC * 1000);

  } catch (e) {
    // driver maybe blocked bot
  }
}

function formatPlace(p) {
  if (!p) return '—';
  if (p.type === 'text') return p.text;
  if (p.type === 'location') return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  return '—';
}

async function dispatchNextDriver(order) {
  const online = listOnlineDrivers();
  const tried = new Set(order.offeredTo || []);
  const next = online.find(d => !tried.has(d));

  if (!next) {
    order.status = 'no_driver';
    saveData();
    await bot.sendMessage(order.passengerId, '😔 Hazırda uyğun sürücü tapılmadı. Bir az sonra yenə yoxla.');
    notifyAdmins(`No driver found for order #${order.id}`);
    return;
  }

  await sendOffer(order, next);
  await bot.sendMessage(order.passengerId, `🔎 Sürücü axtarılır… (offer göndərildi)`);
}

async function notifyAdmins(text) {
  for (const a of ADMIN_IDS) {
    try { await bot.sendMessage(a, `🛠 *Admin xəbərdarlıq:*\n${text}`, { parse_mode: 'Markdown' }); } catch (e) {}
  }
}

// ---- Commands ----
bot.onText(/\/(start)/, async (msg) => {
  upsertUser(msg);
  const chatId = msg.chat.id;
  const u = getUser(chatId);
  const name = msg.from?.first_name || 'istifadəçi';
  await bot.sendMessage(chatId, `Salam, ${name}! PayTaksi botuna xoş gəldin. Rolunu seç:`, mainMenuKeyboard(chatId));
  if (!u.role) setRole(chatId, 'guest');
});

bot.onText(/\/(id)/, async (msg) => {
  upsertUser(msg);
  await bot.sendMessage(msg.chat.id, `Sənin Telegram ID: ${msg.chat.id}`);
});

// ---- Callback buttons ----
bot.on('callback_query', async (q) => {
  const chatId = q.message?.chat?.id;
  if (!chatId) return;

  const dataCb = q.data || '';

  if (dataCb.startsWith('role:')) {
    const role = dataCb.split(':')[1];
    setRole(chatId, role);

    if (role === 'passenger') {
      await bot.sendMessage(chatId, '✅ Sərnişin rejimi aktivdir.', passengerMenu());
    } else if (role === 'driver') {
      const online = !!data.driversOnline[String(chatId)]?.online;
      await bot.sendMessage(chatId, '✅ Sürücü rejimi aktivdir.', driverMenu(online));
    } else if (role === 'admin' && isAdmin(chatId)) {
      await bot.sendMessage(chatId, '✅ Admin panel aktivdir.', adminMenu());
    }
    await bot.answerCallbackQuery(q.id);
    return;
  }

  if (dataCb.startsWith('accept:')) {
    const orderId = dataCb.split(':')[1];
    const order = data.orders[String(orderId)];
    if (!order) {
      await bot.answerCallbackQuery(q.id, { text: 'Sifariş tapılmadı.' });
      return;
    }

    if (order.acceptedBy) {
      await bot.answerCallbackQuery(q.id, { text: 'Bu sifariş artıq qəbul edilib.' });
      return;
    }

    order.acceptedBy = Number(chatId);
    order.status = 'accepted';
    saveData();

    const driverUser = getUser(chatId);
    const driverName = (driverUser.first_name || 'Sürücü') + (driverUser.username ? ` (@${driverUser.username})` : '');

    await bot.sendMessage(chatId, `✅ Sifariş #${order.id} qəbul edildi.`);

    await bot.sendMessage(
      order.passengerId,
      `🚖 Sifariş #${order.id} qəbul edildi!\n\n🧑‍✈️ Sürücü: ${driverName}\n📍 Pickup: ${formatPlace(order.pickup)}\n🏁 Dropoff: ${formatPlace(order.dropoff)}\n\nSürücü tezliklə əlaqə saxlayacaq.`
    );

    notifyAdmins(`Order #${order.id} accepted by driver ${chatId}`);
    await bot.answerCallbackQuery(q.id, { text: 'Qəbul edildi!' });
    return;
  }

  if (dataCb.startsWith('reject:')) {
    const orderId = dataCb.split(':')[1];
    const order = data.orders[String(orderId)];
    if (order && order.status === 'searching' && !order.acceptedBy) {
      // just move on
      await bot.answerCallbackQuery(q.id, { text: 'Rədd edildi. Növbəti sürücüyə göndərilir.' });
      await dispatchNextDriver(order);
      return;
    }
    await bot.answerCallbackQuery(q.id);
    return;
  }

  await bot.answerCallbackQuery(q.id);
});

// ---- Messages ----
bot.on('message', async (msg) => {
  // Ignore commands (handled above)
  if (msg.text && msg.text.startsWith('/')) return;

  upsertUser(msg);
  const chatId = msg.chat.id;
  const u = getUser(chatId);

  // Back
  if (msg.text === '⬅️ Geri') {
    await bot.sendMessage(chatId, 'Rolunu seç:', mainMenuKeyboard(chatId));
    return;
  }

  // Passenger flow
  if (u.role === 'passenger') {
    if (msg.text === 'ℹ️ Kömək') {
      await bot.sendMessage(chatId, '🚖 Taksi sifariş et → pickup & dropoff yaz və ya lokasiya göndər.');
      return;
    }

    if (msg.text === '🚖 Taksi sifariş et') {
      const order = newOrder(chatId);
      setStep(chatId, `pickup:${order.id}`);
      await bot.sendMessage(chatId, '📍 Pickup ünvanını yaz (və ya 📌 Lokasiya göndər):');
      return;
    }

    if (msg.text === '📍 Ünvanı yaz') {
      const order = getActiveOrderByPassenger(chatId) || newOrder(chatId);
      setStep(chatId, `pickup:${order.id}`);
      await bot.sendMessage(chatId, '📍 Pickup ünvanını yaz:');
      return;
    }

    if (msg.text === '📌 Lokasiya göndər') {
      const order = getActiveOrderByPassenger(chatId) || newOrder(chatId);
      setStep(chatId, `pickup:${order.id}`);
      await bot.sendMessage(chatId, '📌 İndi Telegram-da "Location" göndər (kağız sancağı → Location).');
      return;
    }

    // Steps
    if (u.step && u.step.startsWith('pickup:')) {
      const orderId = u.step.split(':')[1];
      const order = data.orders[String(orderId)];
      if (!order) return;

      if (msg.location) {
        order.pickup = { type: 'location', lat: msg.location.latitude, lon: msg.location.longitude };
      } else if (msg.text) {
        order.pickup = { type: 'text', text: msg.text.trim() };
      }
      saveData();

      setStep(chatId, `dropoff:${order.id}`);
      await bot.sendMessage(chatId, '🏁 İndi gedəcəyin ünvanı yaz (dropoff):');
      return;
    }

    if (u.step && u.step.startsWith('dropoff:')) {
      const orderId = u.step.split(':')[1];
      const order = data.orders[String(orderId)];
      if (!order) return;

      if (msg.location) {
        order.dropoff = { type: 'location', lat: msg.location.latitude, lon: msg.location.longitude };
      } else if (msg.text) {
        order.dropoff = { type: 'text', text: msg.text.trim() };
      }
      saveData();

      setStep(chatId, null);
      await bot.sendMessage(chatId, `✅ Sifariş hazırdır:\n\n📍 Pickup: ${formatPlace(order.pickup)}\n🏁 Dropoff: ${formatPlace(order.dropoff)}\n\n🔎 Sürücü axtarılsın? (yaz: Bəli / Xeyr)`);
      setStep(chatId, `confirm:${order.id}`);
      return;
    }

    if (u.step && u.step.startsWith('confirm:')) {
      const orderId = u.step.split(':')[1];
      const order = data.orders[String(orderId)];
      if (!order) return;

      const t = (msg.text || '').toLowerCase();
      if (t.includes('bəli') || t === 'yes' || t === 'he') {
        setStep(chatId, null);
        await dispatchNextDriver(order);
      } else {
        order.status = 'cancelled';
        saveData();
        setStep(chatId, null);
        await bot.sendMessage(chatId, '❌ Sifariş ləğv olundu.', passengerMenu());
      }
      return;
    }
  }

  // Driver flow
  if (u.role === 'driver') {
    const online = !!data.driversOnline[String(chatId)]?.online;

    if (msg.text === 'ℹ️ Kömək') {
      await bot.sendMessage(chatId, '🟢 Onlayn ol → sifariş offerləri gələcək. Offer gələndə Qəbul et bas.');
      return;
    }

    if (msg.text === '🟢 Onlayn ol') {
      data.driversOnline[String(chatId)] = { online: true, since: Date.now() };
      saveData();
      await bot.sendMessage(chatId, '✅ Onlayn oldun. Offer gözlənilir.', driverMenu(true));
      notifyAdmins(`Driver online: ${chatId}`);
      return;
    }

    if (msg.text === '🔴 Offlayn ol') {
      data.driversOnline[String(chatId)] = { online: false, since: Date.now() };
      saveData();
      await bot.sendMessage(chatId, '✅ Offlayn oldun.', driverMenu(false));
      notifyAdmins(`Driver offline: ${chatId}`);
      return;
    }

    if (msg.text === '🟢 Onlaynam') {
      await bot.sendMessage(chatId, '✅ Hazırda onlaynsan.', driverMenu(online));
      return;
    }

    if (msg.text === '📥 Gələn offerlər') {
      await bot.sendMessage(chatId, 'Offer gələndə burda mesaj kimi görünəcək.');
      return;
    }

    return;
  }

  // Admin flow
  if (u.role === 'admin' && isAdmin(chatId)) {
    if (msg.text === '📊 Statistika') {
      const usersCount = Object.keys(data.users).length;
      const onlineDrivers = listOnlineDrivers().length;
      const ordersCount = Object.keys(data.orders).length;
      await bot.sendMessage(chatId, `📊 Statistika\n\n👤 Users: ${usersCount}\n🟢 Online drivers: ${onlineDrivers}\n🧾 Orders: ${ordersCount}`);
      return;
    }

    if (msg.text === '📣 Broadcast') {
      setStep(chatId, 'broadcast');
      await bot.sendMessage(chatId, '📣 Göndəriləcək mətni yaz:');
      return;
    }

    if (u.step === 'broadcast' && msg.text) {
      const text = msg.text;
      setStep(chatId, null);
      let sent = 0;
      for (const uid of Object.keys(data.users)) {
        try {
          await bot.sendMessage(Number(uid), `📣 *Bildiriş:*\n${text}`, { parse_mode: 'Markdown' });
          sent++;
        } catch (e) {}
      }
      await bot.sendMessage(chatId, `✅ Broadcast göndərildi. Çatdırılan: ${sent}`);
      return;
    }
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err?.message || err);
});

console.log('PayTaksi bot işləyir...');
