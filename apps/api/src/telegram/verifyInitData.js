import crypto from 'node:crypto';

/**
 * Verify Telegram WebApp initData. Returns parsed object if valid, otherwise null.
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(initData, botToken, maxAgeSeconds = 24 * 60 * 60) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    // check auth_date
    const authDate = Number(params.get('auth_date') || '0');
    const now = Math.floor(Date.now() / 1000);
    if (!authDate || (now - authDate) > maxAgeSeconds) return null;

    // data-check-string
    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push([k, v]);
    pairs.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computed !== hash) return null;

    // parse user
    const userJson = params.get('user');
    const user = userJson ? JSON.parse(userJson) : null;

    return { ...Object.fromEntries(params.entries()), user };
  } catch {
    return null;
  }
}
