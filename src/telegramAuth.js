import crypto from 'crypto';

/**
 * Validate Telegram Web App initData (hash check).
 * Docs: https://core.telegram.org/bots/webapps
 */
export function validateTelegramWebAppData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: 'missing_initData_or_token' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing_hash' };

  params.delete('hash');

  // Create data-check-string: sort keys and join as key=value with \n
  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const ok = timingSafeEqualHex(computedHash, hash);
  return ok ? { ok: true } : { ok: false, reason: 'bad_hash' };
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
