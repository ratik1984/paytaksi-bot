import crypto from "crypto";

export function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [k, v] of params.entries()) data[k] = v;
  return data;
}

// Telegram WebApp initData verification (HMAC SHA-256)
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
export function verifyTelegramInitData(initData, botToken) {
  try {
    const data = parseInitData(initData);
    const hash = data.hash;
    if (!hash) return { ok: false, error: "no_hash" };
    delete data.hash;

    const dataCheckString = Object.keys(data)
      .sort()
      .map((k) => `${k}=${data[k]}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const calculated = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    // timing safe compare
    const ok =
      Buffer.byteLength(calculated) === Buffer.byteLength(hash) &&
      crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash));

    return { ok };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
