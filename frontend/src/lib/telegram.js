import WebApp from '@twa-dev/sdk';

export function getInitData() {
  try {
    return WebApp.initData || '';
  } catch {
    return '';
  }
}

export function getTgUser() {
  try {
    return WebApp.initDataUnsafe?.user || null;
  } catch {
    return null;
  }
}

export function expand() {
  try { WebApp.expand(); } catch {}
}
