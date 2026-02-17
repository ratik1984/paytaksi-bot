import crypto from 'crypto';

// Telegram Mini App (WebApp) initData verification
// Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

function parseInitData(initData) {
  const p = new URLSearchParams(initData);
  const obj = {};
  for (const [k, v] of p.entries()) obj[k] = v;
  return obj;
}

export function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: 'missing' };

  const data = parseInitData(initData);
  const theirHash = data.hash;
  if (!theirHash) return { ok: false, reason: 'no_hash' };
  delete data.hash;

  const pairs = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k]}`);
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const h = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const ok = crypto.timingSafeEqual(Buffer.from(h), Buffer.from(theirHash));
  if (!ok) return { ok: false, reason: 'bad_hash' };

  // user field is JSON
  let user = null;
  try {
    if (data.user) user = JSON.parse(data.user);
  } catch {}

  return { ok: true, user, data };
}
