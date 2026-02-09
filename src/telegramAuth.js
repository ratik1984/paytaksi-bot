import crypto from 'crypto'

// Verify Telegram WebApp initData
// Ref: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, botToken) {
  if (!initData) return { ok: false, reason: 'missing_init_data' }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return { ok: false, reason: 'missing_hash' }

  params.delete('hash')

  // data_check_string
  const pairs = []
  for (const [k, v] of params.entries()) pairs.push([k, v])
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n')

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  const ok = safeEqual(computed, hash)
  return ok ? { ok: true, params: Object.fromEntries(params.entries()) } : { ok: false, reason: 'bad_hash' }
}

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(a)
    const bb = Buffer.from(b)
    if (ba.length !== bb.length) return false
    return crypto.timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}
