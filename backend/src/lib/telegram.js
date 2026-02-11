import crypto from 'crypto';

// Validates Telegram WebApp initData string.
// Ref: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
export function verifyTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return { ok: false, error: 'No initData' };
  if (!botToken) return { ok: false, error: 'Missing TELEGRAM_BOT_TOKEN' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'Missing hash' };
  params.delete('hash');

  // Create data_check_string
  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!timingSafeEqualHex(computed, hash)) {
    return { ok: false, error: 'Bad hash' };
  }

  // Optional: check auth_date freshness
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  const maxAgeSec = parseInt(process.env.TELEGRAM_AUTH_MAX_AGE_SEC || '86400', 10);
  if (authDate && now - authDate > maxAgeSec) {
    return { ok: false, error: 'initData expired' };
  }

  let userObj = null;
  try {
    const u = params.get('user');
    if (u) userObj = JSON.parse(u);
  } catch {
    // ignore
  }

  return { ok: true, user: userObj, params: Object.fromEntries(params.entries()) };
}

function timingSafeEqualHex(a, b) {
  try {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
