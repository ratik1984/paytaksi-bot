import WebApp from "@twa-dev/sdk";

export function getTgUser() {
  try {
    const wa = WebApp;
    wa.ready();
    wa.expand();
    const u = wa.initDataUnsafe?.user;
    if (!u) return null;
    return {
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      username: u.username
    };
  } catch {
    return null;
  }
}

export function isTelegram() {
  try {
    return !!WebApp?.initDataUnsafe;
  } catch { return false; }
}
