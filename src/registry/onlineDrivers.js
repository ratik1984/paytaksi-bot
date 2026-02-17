const online = new Map(); // telegramId => boolean
function setOnline(tgId, val){ online.set(String(tgId), !!val); }
function isOnline(tgId){ return online.get(String(tgId)) === true; }
function listOnline(){ return Array.from(online.entries()).filter(([k,v])=>v).map(([k])=>k); }

module.exports = { setOnline, isOnline, listOnline };
