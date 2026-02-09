import { db } from "./db.js";
import { now, uid, parseJsonSafe } from "./util.js";

export function upsertUserFromTelegram({ tgUser, role }) {
  const ts = now();
  const row = db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgUser.id);
  if (!row) {
    const stmt = db.prepare(`
      INSERT INTO users (tg_id, role, first_name, last_name, username, created_at)
      VALUES (@tg_id, @role, @first_name, @last_name, @username, @created_at)
    `);
    const info = stmt.run({
      tg_id: tgUser.id,
      role,
      first_name: tgUser.first_name || null,
      last_name: tgUser.last_name || null,
      username: tgUser.username || null,
      created_at: ts
    });
    const userId = info.lastInsertRowid;
    if (role === "driver") ensureDriverProfile(userId);
    return getUserById(userId);
  }
  // keep role if admin else update requested role (user can be both via separate logins; we store one role per account)
  const newRole = row.role === "admin" ? "admin" : role;
  db.prepare(`
    UPDATE users SET role=@role, first_name=@first_name, last_name=@last_name, username=@username
    WHERE id=@id
  `).run({
    id: row.id,
    role: newRole,
    first_name: tgUser.first_name || null,
    last_name: tgUser.last_name || null,
    username: tgUser.username || null
  });
  if (newRole === "driver") ensureDriverProfile(row.id);
  return getUserById(row.id);
}

export function setAdminRoleByTgId(tg_id) {
  const r = db.prepare("SELECT id FROM users WHERE tg_id=?").get(tg_id);
  if (!r) return;
  db.prepare("UPDATE users SET role='admin' WHERE tg_id=?").run(tg_id);
}

export function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(id) || null;
}
export function getUserByTgId(tg_id) {
  return db.prepare("SELECT * FROM users WHERE tg_id=?").get(tg_id) || null;
}

export function ensureDriverProfile(user_id) {
  const row = db.prepare("SELECT * FROM driver_profile WHERE user_id=?").get(user_id);
  if (!row) db.prepare("INSERT INTO driver_profile (user_id) VALUES (?)").run(user_id);
}

export function updateDriverProfile(user_id, patch) {
  ensureDriverProfile(user_id);
  const cur = db.prepare("SELECT * FROM driver_profile WHERE user_id=?").get(user_id);
  const next = { ...cur, ...patch };
  db.prepare(`
    UPDATE driver_profile SET
      car_brand=@car_brand, car_model=@car_model, car_color=@car_color, car_plate=@car_plate,
      seats=@seats, options_json=@options_json,
      is_online=@is_online, last_lat=@last_lat, last_lng=@last_lng, last_update=@last_update
    WHERE user_id=@user_id
  `).run({
    user_id,
    car_brand: next.car_brand || null,
    car_model: next.car_model || null,
    car_color: next.car_color || null,
    car_plate: next.car_plate || null,
    seats: Number(next.seats || 4),
    options_json: typeof next.options_json === "string" ? next.options_json : JSON.stringify(next.options_json ?? parseJsonSafe(cur.options_json, {})),
    is_online: Number(next.is_online || 0),
    last_lat: (next.last_lat ?? null),
    last_lng: (next.last_lng ?? null),
    last_update: (next.last_update ?? null),
  });
  return db.prepare("SELECT * FROM driver_profile WHERE user_id=?").get(user_id);
}

export function listOnlineDrivers() {
  return db.prepare(`
    SELECT u.*, d.*
    FROM driver_profile d
    JOIN users u ON u.id=d.user_id
    WHERE d.is_online=1
    ORDER BY d.last_update DESC
    LIMIT 200
  `).all();
}

export function createRide({ passenger_user_id, pickup, dropoff, payment_method, note }) {
  const ts = now();
  const id = uid("ride");
  db.prepare(`
    INSERT INTO rides (
      id, passenger_user_id, status, created_at, updated_at,
      pickup_text, pickup_lat, pickup_lng,
      dropoff_text, dropoff_lat, dropoff_lng,
      payment_method, note
    )
    VALUES (
      @id, @passenger_user_id, 'searching', @ts, @ts,
      @pickup_text, @pickup_lat, @pickup_lng,
      @dropoff_text, @dropoff_lat, @dropoff_lng,
      @payment_method, @note
    )
  `).run({
    id,
    passenger_user_id,
    ts,
    pickup_text: pickup.text,
    pickup_lat: pickup.lat,
    pickup_lng: pickup.lng,
    dropoff_text: dropoff.text,
    dropoff_lat: dropoff.lat,
    dropoff_lng: dropoff.lng,
    payment_method,
    note: note || null
  });
  addRideEvent(id, "passenger", "ride_created", { pickup, dropoff, payment_method });
  return getRide(id);
}

export function getRide(id) {
  return db.prepare("SELECT * FROM rides WHERE id=?").get(id) || null;
}

export function addRideEvent(ride_id, actor_role, type, payload={}) {
  db.prepare("INSERT INTO ride_events (ride_id, ts, actor_role, type, payload_json) VALUES (?,?,?,?,?)")
    .run(ride_id, now(), actor_role || null, type, JSON.stringify(payload||{}));
}

export function listPassengerRides(passenger_user_id, limit=50) {
  return db.prepare("SELECT * FROM rides WHERE passenger_user_id=? ORDER BY created_at DESC LIMIT ?").all(passenger_user_id, limit);
}
export function listDriverRides(driver_user_id, limit=50) {
  return db.prepare("SELECT * FROM rides WHERE driver_user_id=? ORDER BY created_at DESC LIMIT ?").all(driver_user_id, limit);
}

export function assignRideToDriver(ride_id, driver_user_id) {
  const ts = now();
  db.prepare(`
    UPDATE rides SET status='offered', driver_user_id=?, updated_at=?
    WHERE id=? AND status IN ('searching','draft')
  `).run(driver_user_id, ts, ride_id);
  addRideEvent(ride_id, "system", "ride_offered", { driver_user_id });
  return getRide(ride_id);
}

export function acceptRide(ride_id, driver_user_id) {
  const ts = now();
  db.prepare(`
    UPDATE rides SET status='accepted', driver_user_id=?, updated_at=?
    WHERE id=? AND status IN ('offered','searching') 
  `).run(driver_user_id, ts, ride_id);
  addRideEvent(ride_id, "driver", "ride_accepted", { driver_user_id });
  return getRide(ride_id);
}

export function updateRideStatus(ride_id, actor_role, status, payload={}) {
  const ts = now();
  db.prepare("UPDATE rides SET status=?, updated_at=? WHERE id=?").run(status, ts, ride_id);
  addRideEvent(ride_id, actor_role, "status_changed", { status, ...payload });
  return getRide(ride_id);
}

export function rateUser(user_id, ratingInt) {
  const r = db.prepare("SELECT rating, rating_count FROM users WHERE id=?").get(user_id);
  if (!r) return null;
  const cnt = r.rating_count || 0;
  const newCnt = cnt + 1;
  const newRating = ((r.rating || 5) * cnt + ratingInt) / newCnt;
  db.prepare("UPDATE users SET rating=?, rating_count=? WHERE id=?").run(newRating, newCnt, user_id);
  return db.prepare("SELECT rating, rating_count FROM users WHERE id=?").get(user_id);
}

export function adminStats() {
  const users = db.prepare("SELECT role, COUNT(*) c FROM users GROUP BY role").all();
  const ridesByStatus = db.prepare("SELECT status, COUNT(*) c FROM rides GROUP BY status").all();
  const lastRides = db.prepare(`
    SELECT r.*, u.username passenger_username
    FROM rides r JOIN users u ON u.id=r.passenger_user_id
    ORDER BY r.created_at DESC LIMIT 20
  `).all();
  return { users, ridesByStatus, lastRides };
}

export function searchOpenRides() {
  return db.prepare("SELECT * FROM rides WHERE status IN ('searching','offered') ORDER BY created_at DESC LIMIT 50").all();
}
