/**
 * Very small in-memory state for wizards.
 * For production you'd move this to DB/Redis. For MVP it's ok.
 */
const state = new Map(); // key: telegramId, value: { step, data }
function get(key){ return state.get(key); }
function set(key, val){ state.set(key, val); }
function clear(key){ state.delete(key); }

module.exports = { get, set, clear };
