import crypto from "crypto";

/**
 * Verify Telegram WebApp initData
 * Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(initData, botToken) {
  if (!initData || typeof initData !== "string") return { ok: false, error: "initData_missing" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "hash_missing" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const safeEqual = (a, b) => {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    if (aa.length !== bb.length) return false;
    return crypto.timingSafeEqual(aa, bb);
  };

  if (!safeEqual(computedHash, hash)) return { ok: false, error: "hash_invalid" };

  const userJson = params.get("user");
  if (!userJson) return { ok: false, error: "user_missing" };

  let user;
  try { user = JSON.parse(userJson); } catch { return { ok: false, error: "user_parse" }; }

  return { ok: true, user, raw: Object.fromEntries(params.entries()) };
}
