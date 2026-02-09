import crypto from 'crypto';

export function verifyWebhookSecret(secret) {
  return (req, res, next) => {
    // Optional: you can also check 'X-Telegram-Bot-Api-Secret-Token' if you set it.
    next();
  };
}

// Telegram WebApp initData validation
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyWebAppInitData(initData, botToken) {
  if (!initData) throw new Error('initData_missing');
  if (!botToken) throw new Error('bot_token_missing');

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calcHash !== hash) throw new Error('initData_invalid_hash');

  const userRaw = params.get('user');
  if (!userRaw) throw new Error('user_missing');
  const user = JSON.parse(userRaw);

  // Optional: auth_date freshness (1 day)
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) throw new Error('auth_date_missing');
  const now = Math.floor(Date.now()/1000);
  if (now - authDate > 86400) throw new Error('initData_expired');

  return user;
}
