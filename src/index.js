import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import morgan from 'morgan'
import crypto from 'crypto'
import { Telegraf, Markup } from 'telegraf'
import { nanoid } from 'nanoid'
import { z } from 'zod'

import { db, initDb, save } from './db.js'
import { verifyInitData } from './telegramAuth.js'
import { calcPrice } from './pricing.js'

const BOT_TOKEN = process.env.BOT_TOKEN
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in env')
  process.exit(1)
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s))
  .filter(n => Number.isFinite(n))

const PORT = Number(process.env.PORT || 3000)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '')

// --- Bot ---
const bot = new Telegraf(BOT_TOKEN)

function isAdminId(id) {
  return ADMIN_IDS.includes(Number(id))
}

function webAppUrl(path) {
  return `${PUBLIC_BASE_URL}${path}`
}

async function ensureUser(telegramUser, roleHint = 'passenger') {
  const id = String(telegramUser.id)
  const u = db.data.users[id]
  if (u) return u
  const created = {
    id,
    tgId: telegramUser.id,
    first_name: telegramUser.first_name || '',
    last_name: telegramUser.last_name || '',
    username: telegramUser.username || '',
    role: isAdminId(telegramUser.id) ? 'admin' : roleHint,
    phone: '',
    driver: {
      carModel: '',
      carPlate: '',
      rating: 5.0,
      trips: 0
    },
    isOnline: false,
    createdAt: Date.now()
  }
  db.data.users[id] = created
  await save()
  return created
}

async function notifyAdmins(text, extra) {
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, text, extra)
    } catch {}
  }
}

async function notifyDriversNewRide(ride) {
  // Send to online drivers (users with role driver and isOnline true)
  const drivers = Object.values(db.data.users).filter(u => u.role === 'driver' && u.isOnline)
  const msg = `🚖 Yeni sifariş\n\n📍 Götür: ${ride.pickup?.label || '—'}\n🏁 Çatdır: ${ride.dropoff?.label || '—'}\n💰 Təxmini: ${ride.price} ${db.data.settings.currency}\n\nSifarişi qəbul etmək üçün Mini App-da “Sifarişlər” bölməsinə keçin.`
  for (const d of drivers) {
    try {
      await bot.telegram.sendMessage(d.tgId, msg, Markup.inlineKeyboard([
        Markup.button.webApp('Aç (Sürücü)', webAppUrl(`/webapp/driver.html?ride=${ride.id}`))
      ]))
    } catch {}
  }
}

bot.start(async ctx => {
  await ensureUser(ctx.from)
  const buttons = [
    [Markup.button.webApp('🚕 Taksi çağır (Sərnişin)', webAppUrl('/webapp/passenger.html'))],
    [Markup.button.webApp('🧑‍✈️ Sürücü paneli', webAppUrl('/webapp/driver.html'))],
  ]
  if (isAdminId(ctx.from.id)) buttons.push([Markup.button.webApp('🛠 Admin panel', webAppUrl('/webapp/admin.html'))])

  await ctx.reply(
    'PayTaksi ✅\n\nAşağıdan seçin:',
    Markup.keyboard(buttons).resize()
  )
})

bot.command('admin', async ctx => {
  if (!isAdminId(ctx.from.id)) return ctx.reply('Bu komanda yalnız admin üçündür.')
  await ctx.reply('Admin panel:', Markup.inlineKeyboard([
    Markup.button.webApp('🛠 Admin panel', webAppUrl('/webapp/admin.html'))
  ]))
})

bot.command('driver', async ctx => {
  await ensureUser(ctx.from, 'driver')
  await ctx.reply('Sürücü paneli:', Markup.inlineKeyboard([
    Markup.button.webApp('🧑‍✈️ Aç (Sürücü)', webAppUrl('/webapp/driver.html'))
  ]))
})

bot.command('help', async ctx => {
  await ctx.reply('Komandalar:\n/start - menyu\n/driver - sürücü panel\n/admin - admin panel (yalnız admin)')
})

// --- Web server ---
const app = express()
app.use(helmet())
app.use(cors())
app.use(morgan('dev'))
app.use(express.json({ limit: '512kb' }))

app.get("/health", (_req, res) => res.json({ ok: true }))

// Static Mini App UI
app.use(express.static(new URL("../public", import.meta.url).pathname))
app.use('/webapp', express.static(new URL('../public/webapp', import.meta.url).pathname))

function authFromInitData(req, res) {
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData || ''
  const v = verifyInitData(String(initData), BOT_TOKEN)
  if (!v.ok) {
    res.status(401).json({ ok: false, error: 'unauthorized', reason: v.reason })
    return null
  }
  const userJson = v.params?.user
  if (!userJson) {
    res.status(401).json({ ok: false, error: 'unauthorized', reason: 'missing_user' })
    return null
  }
  let tgUser
  try {
    tgUser = JSON.parse(userJson)
  } catch {
    res.status(401).json({ ok: false, error: 'unauthorized', reason: 'bad_user_json' })
    return null
  }
  return tgUser
}

// --- API ---
app.post("/api/me", async (req, res) => {
  const tgUser = authFromInitData(req, res);
  if (!tgUser) return;
  const user = await ensureUser(tgUser);
  res.json({ ok: true, user });
})

app.get("/api/me", async (req, res) => {
  const tgUser = authFromInitData(req, res);
  if (!tgUser) return;
  const user = await ensureUser(tgUser);
  res.json({ ok: true, user });
})

app.post('/api/user/update', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  const schema = z.object({ phone: z.string().max(32).optional(), driver: z.object({ carModel: z.string().max(64).optional(), carPlate: z.string().max(32).optional() }).optional(), role: z.enum(['passenger','driver']).optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request', details: parsed.error.errors })

  const u = await ensureUser(tgUser)
  if (typeof parsed.data.phone === 'string') u.phone = parsed.data.phone
  if (parsed.data.driver) {
    u.driver ||= { carModel:'', carPlate:'', rating:5.0, trips:0 }
    if (typeof parsed.data.driver.carModel === 'string') u.driver.carModel = parsed.data.driver.carModel
    if (typeof parsed.data.driver.carPlate === 'string') u.driver.carPlate = parsed.data.driver.carPlate
  }
  if (parsed.data.role) u.role = parsed.data.role
  db.data.users[String(tgUser.id)] = u
  await save()
  res.json({ ok: true, user: u })
})



// Passenger: price estimate (client sends distance/duration)
app.post('/api/passenger/estimate', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  await ensureUser(tgUser, 'passenger')
  const schema = z.object({ distanceKm: z.number().min(0).max(500), durationMin: z.number().min(0).max(10000) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' })
  const price = calcPrice(db.data.settings, parsed.data)
  res.json({ ok: true, price, currency: db.data.settings.currency })
})

// Passenger: create ride request
app.post('/api/passenger/requestRide', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  const u = await ensureUser(tgUser, 'passenger')
  u.role = 'passenger'

  const schema = z.object({
    pickup: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), text: z.string().max(160) }),
    dropoff: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), text: z.string().max(160) })
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request', details: parsed.error.errors })

  const id = nanoid(10)
  const ride = {
    id,
    passengerId: String(tgUser.id),
    driverId: '',
    status: 'PENDING',
    pickup: parsed.data.pickup,
    dropoff: parsed.data.dropoff,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    price: 0,
    currency: db.data.settings.currency,
    distanceKm: 0,
    durationMin: 0
  }
  db.data.rides[id] = ride
  await save()

  // Notify online drivers and admins
  const drivers = Object.values(db.data.users).filter(x => x?.role === 'driver' && x?.isOnline)
  const msg = `🆕 Yeni sifariş

📍 Götür: ${ride.pickup.text}
🏁 Çatdır: ${ride.dropoff.text}

Sifarişi qəbul etmək üçün Sürücü panelinə daxil olun.`
  for (const d of drivers) {
    try { await bot.telegram.sendMessage(Number(d.id), msg) } catch {}
  }
  for (const aid of ADMIN_IDS) {
    try { await bot.telegram.sendMessage(aid, `🛎 Admin: ${msg}
Sərnişin: ${u.name} (${u.id})`) } catch {}
  }

  res.json({ ok: true, ride })
})
app.post('/api/driver/online', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  const u = await ensureUser(tgUser, 'driver')
  const schema = z.object({ online: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' })

  u.role = 'driver'
  u.isOnline = parsed.data.online
  await save()
  res.json({ ok: true, user: u })
})

app.get('/api/rides', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  const u = await ensureUser(tgUser)
  const rides = Object.values(db.data.rides)
    .filter(r => r.passengerId === String(tgUser.id) || r.driverId === String(tgUser.id) || (u.role === 'admin' && isAdminId(tgUser.id)))
    .sort((a,b) => b.createdAt - a.createdAt)
    .slice(0, 50)
  res.json({ ok: true, rides })
})

app.get('/api/driver/queue', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  const u = await ensureUser(tgUser, 'driver')
  u.role = 'driver'
  const rides = Object.values(db.data.rides)
    .filter(r => r.status === 'PENDING')
    .sort((a,b) => b.createdAt - a.createdAt)
    .slice(0, 50)
  res.json({ ok: true, rides })
})


app.post('/api/driver/accept', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  const u = await ensureUser(tgUser, 'driver')
  u.role = 'driver'

  const schema = z.object({ rideId: z.string().min(3).max(32) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' })

  const ride = db.data.rides[parsed.data.rideId]
  if (!ride) return res.status(404).json({ ok: false, error: 'not_found' })
  if (ride.status !== 'PENDING') return res.status(400).json({ ok: false, error: 'not_pending' })

  ride.driverId = String(tgUser.id)
  ride.status = 'ACCEPTED'
  ride.updatedAt = Date.now()
  ride.timeline.push({ t: Date.now(), a: 'ACCEPT', by: String(tgUser.id) })
  await save()

  const passengerId = Number(ride.passengerId)
  const driverLabel = `${u.first_name}${u.username ? ' (@' + u.username + ')' : ''} • ${u.driver?.carModel || 'Avto'} • ${u.driver?.carPlate || '—'}`

  try {
    await bot.telegram.sendMessage(passengerId, `🚖 Sifariş qəbul edildi (#${ride.id})\n\nSürücü: ${driverLabel}\n\n📍 ${ride.pickup.label}\n🏁 ${ride.dropoff.label}\n💰 ${ride.price} ${db.data.settings.currency}`, {
      reply_markup: { inline_keyboard: [[{ text: 'Aç (Sərnişin)', web_app: { url: webAppUrl(`/webapp/passenger.html?ride=${ride.id}`) } }]] }
    })
  } catch {}

  try {
    await bot.telegram.sendMessage(tgUser.id, `✅ Sifarişi qəbul etdin (#${ride.id})\n\nSərnişinlə əlaqə üçün Telegram chat istifadə et.`, {
      reply_markup: { inline_keyboard: [[{ text: 'Aç (Sürücü)', web_app: { url: webAppUrl(`/webapp/driver.html?ride=${ride.id}`) } }]] }
    })
  } catch {}

  await notifyAdmins(`✅ Sifariş #${ride.id} qəbul edildi\nSürücü: @${u.username || u.first_name || u.tgId}`)

  res.json({ ok: true, ride })
})

app.post('/api/ride/status', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  const schema = z.object({ rideId: z.string().min(3).max(32), status: z.enum(['CANCELLED','ARRIVED','STARTED','COMPLETED']) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_request' })

  const ride = db.data.rides[parsed.data.rideId]
  if (!ride) return res.status(404).json({ ok: false, error: 'not_found' })

  const uid = String(tgUser.id)
  const isRideParty = ride.passengerId === uid || ride.driverId === uid || isAdminId(tgUser.id)
  if (!isRideParty) return res.status(403).json({ ok: false, error: 'forbidden' })

  // Passenger can only cancel while pending/accepted
  if (parsed.data.status === 'CANCELLED' && ride.passengerId === uid) {
    if (!['PENDING','ACCEPTED'].includes(ride.status)) return res.status(400).json({ ok: false, error: 'cannot_cancel' })
  }

  // Driver can update flow
  if (ride.driverId === uid) {
    // ok
  }

  ride.status = parsed.data.status
  ride.updatedAt = Date.now()
  ride.timeline.push({ t: Date.now(), a: `STATUS_${parsed.data.status}`, by: uid })
  await save()

  const passengerId = Number(ride.passengerId)
  const driverId = ride.driverId ? Number(ride.driverId) : null
  const msg = `ℹ️ Sifariş #${ride.id} status: ${ride.status}`

  if (passengerId) try { await bot.telegram.sendMessage(passengerId, msg) } catch {}
  if (driverId) try { await bot.telegram.sendMessage(driverId, msg) } catch {}
  await notifyAdmins(`ℹ️ #${ride.id} status: ${ride.status}`)

  res.json({ ok: true, ride })
})

// --- Admin API ---
app.get('/api/admin/stats', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  if (!isAdminId(tgUser.id)) return res.status(403).json({ ok:false, error:'forbidden' })

  const users = Object.values(db.data.users)
  const rides = Object.values(db.data.rides)
  const stats = {
    users: users.length,
    drivers: users.filter(u => u.role === 'driver').length,
    onlineDrivers: users.filter(u => u.role === 'driver' && u.isOnline).length,
    ridesTotal: rides.length,
    ridesPending: rides.filter(r => r.status === 'PENDING').length,
    ridesAccepted: rides.filter(r => r.status === 'ACCEPTED').length,
    ridesCompleted: rides.filter(r => r.status === 'COMPLETED').length,
  }
  res.json({ ok:true, stats, settings: db.data.settings })
})

app.get('/api/admin/settings', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  if (!isAdminId(tgUser.id)) return res.status(403).json({ ok:false, error:'forbidden' })
  res.json({ ok:true, settings: db.data.settings })
})

app.get('/api/admin/drivers', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  if (!isAdminId(tgUser.id)) return res.status(403).json({ ok:false, error:'forbidden' })
  const drivers = Object.values(db.data.users).filter(u => u.role === 'driver').sort((a,b) => (b.isOnline?1:0) - (a.isOnline?1:0))
  res.json({ ok:true, drivers })
})

app.get('/api/admin/rides', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  if (!isAdminId(tgUser.id)) return res.status(403).json({ ok:false, error:'forbidden' })
  const rides = Object.values(db.data.rides).sort((a,b) => b.createdAt - a.createdAt).slice(0, 200)
  res.json({ ok:true, rides })
})

app.post('/api/admin/settings', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  if (!isAdminId(tgUser.id)) return res.status(403).json({ ok:false, error:'forbidden' })

  const schema = z.object({ baseFare: z.number().min(0).optional(), perKm: z.number().min(0).optional(), perMin: z.number().min(0).optional(), currency: z.string().max(8).optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok:false, error:'bad_request', details: parsed.error.errors })

  db.data.settings = { ...db.data.settings, ...parsed.data }
  await save()
  await notifyAdmins(`⚙️ Tariflər yeniləndi: base=${db.data.settings.baseFare}, km=${db.data.settings.perKm}, min=${db.data.settings.perMin}`)
  res.json({ ok:true, settings: db.data.settings })
})

app.post('/api/admin/broadcast', async (req, res) => {
  const tgUser = authFromInitData(req, res)
  if (!tgUser) return
  if (!isAdminId(tgUser.id)) return res.status(403).json({ ok:false, error:'forbidden' })

  const schema = z.object({ text: z.string().min(1).max(1500), target: z.enum(['all','drivers','passengers']).default('all') })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ ok:false, error:'bad_request' })

  const users = Object.values(db.data.users)
  const targets = users.filter(u => {
    if (parsed.data.target === 'all') return true
    if (parsed.data.target === 'drivers') return u.role === 'driver'
    if (parsed.data.target === 'passengers') return u.role === 'passenger'
    return false
  })

  let sent = 0
  for (const u of targets) {
    try {
      await bot.telegram.sendMessage(u.tgId, parsed.data.text)
      sent++
    } catch {}
  }
  res.json({ ok:true, sent })
})

// Webhook support (optional)
function webhookPath() {
  const secret = process.env.WEBHOOK_SECRET || ''
  if (!secret) return null
  const hash = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 24)
  return `/telegram/webhook/${hash}`
}

async function start() {
  await initDb()

  app.listen(PORT, () => {
    console.log(`PayTaksi server listening on :${PORT}`)
  })

  const wh = webhookPath()
  const useWebhook = Boolean(wh && PUBLIC_BASE_URL && PUBLIC_BASE_URL.startsWith('https://'))

  if (useWebhook) {
    app.post(wh, (req, res) => {
      bot.handleUpdate(req.body, res)
    })
    const url = `${PUBLIC_BASE_URL}${wh}`
    console.log('Setting webhook:', url)
    await bot.telegram.setWebhook(url)
  } else {
    console.log('Launching bot in long-polling mode')
    await bot.telegram.deleteWebhook().catch(() => {})
    bot.launch()
  }

  process.once('SIGINT', () => bot.stop('SIGINT'))
  process.once('SIGTERM', () => bot.stop('SIGTERM'))
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})
