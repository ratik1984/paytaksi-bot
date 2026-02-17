// In-memory state for multi-step flows (registration/ride). For production, move to DB/Redis.
export const passengerFlow = new Map(); // tg_user_id -> { step, data }
export const driverFlow = new Map();
export const rideFlow = new Map(); // passenger tg_user_id -> { step, pickup, drop }
