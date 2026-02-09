import express from "express";
import { z } from "zod";
import { verifyInitData } from "./telegramAuth.js";
import { CONFIG } from "./config.js";
import {
  upsertUserFromTelegram, setAdminRoleByTgId,
  getUserByTgId, updateDriverProfile, listOnlineDrivers,
  createRide, listPassengerRides, listDriverRides, getRide,
  assignRideToDriver, acceptRide, updateRideStatus, rateUser,
  adminStats, searchOpenRides
} from "./repo.js";
import { now, clamp } from "./util.js";

export function buildApi({ io }) {
  const router = express.Router();

  function auth(requiredRole=null) {
    return (req, res, next) => {
      const initData = req.get("x-init-data") || req.query.initData;
      const role = req.get("x-role") || req.query.role || "passenger";
      const vr = verifyInitData(initData, CONFIG.BOT_TOKEN);
      if (!vr.ok) return res.status(401).json({ ok:false, error: vr.error });
      const tgUser = vr.user;
      // auto-admin if in ADMIN_IDS
      if (CONFIG.ADMIN_IDS.includes(Number(tgUser.id))) setAdminRoleByTgId(Number(tgUser.id));
      const user = upsertUserFromTelegram({ tgUser, role: String(role) });
      if (requiredRole && user.role !== requiredRole && user.role !== "admin") {
        return res.status(403).json({ ok:false, error:"forbidden" });
      }
      req.user = user;
      req.tgUser = tgUser;
      next();
    };
  }

  router.get("/me", auth(), (req,res)=> {
    res.json({ ok:true, user:req.user, server_ts: now() });
  });

  // DRIVER: profile + online status + live location
  router.post("/driver/profile", auth("driver"), (req,res)=>{
    const schema = z.object({
      car_brand: z.string().max(60).optional(),
      car_model: z.string().max(60).optional(),
      car_color: z.string().max(30).optional(),
      car_plate: z.string().max(20).optional(),
      seats: z.number().int().min(1).max(8).optional(),
      options: z.record(z.any()).optional()
    });
    const data = schema.safeParse(req.body);
    if (!data.success) return res.status(400).json({ ok:false, error:"bad_input", details:data.error.flatten() });
    const patch = {
      ...data.data,
      options_json: data.data.options ? JSON.stringify(data.data.options) : undefined
    };
    const row = updateDriverProfile(req.user.id, patch);
    res.json({ ok:true, driver: row });
  });

  router.post("/driver/online", auth("driver"), (req,res)=>{
    const schema = z.object({ is_online: z.boolean() });
    const data = schema.safeParse(req.body);
    if (!data.success) return res.status(400).json({ ok:false, error:"bad_input" });
    const row = updateDriverProfile(req.user.id, { is_online: data.data.is_online ? 1 : 0, last_update: now() });
    io.to(`admin`).emit("driver_online_change", { driver_user_id: req.user.id, is_online: row.is_online });
    res.json({ ok:true, driver: row });
  });

  router.post("/driver/location", auth("driver"), (req,res)=>{
    const schema = z.object({ lat: z.number(), lng: z.number(), ride_id: z.string().optional() });
    const data = schema.safeParse(req.body);
    if (!data.success) return res.status(400).json({ ok:false, error:"bad_input" });
    const { lat, lng, ride_id } = data.data;
    const row = updateDriverProfile(req.user.id, { last_lat: lat, last_lng: lng, last_update: now() });

    if (ride_id) {
      io.to(`ride:${ride_id}`).emit("driver_location", { ride_id, driver_user_id: req.user.id, lat, lng, ts: now() });
    }
    io.to(`admin`).emit("driver_location", { driver_user_id: req.user.id, lat, lng, ts: now() });
    res.json({ ok:true, driver: row });
  });

  router.get("/drivers/online", auth(), (req,res)=>{
    const drivers = listOnlineDrivers().map(d => ({
      tg_id: d.tg_id, username: d.username, first_name: d.first_name,
      user_id: d.user_id, rating: d.rating, rating_count: d.rating_count,
      car_brand: d.car_brand, car_model: d.car_model, car_color: d.car_color, car_plate: d.car_plate,
      seats: d.seats, options_json: d.options_json,
      last_lat: d.last_lat, last_lng: d.last_lng, last_update: d.last_update
    }));
    res.json({ ok:true, drivers });
  });

  // PASSENGER: create ride
  router.post("/rides", auth("passenger"), (req,res)=>{
    const schema = z.object({
      pickup: z.object({ text:z.string().min(2).max(200), lat:z.number(), lng:z.number() }),
      dropoff: z.object({ text:z.string().min(2).max(200), lat:z.number(), lng:z.number() }),
      payment_method: z.enum(["cash","card"]),
      note: z.string().max(200).optional()
    });
    const data = schema.safeParse(req.body);
    if (!data.success) return res.status(400).json({ ok:false, error:"bad_input", details:data.error.flatten() });

    const ride = createRide({
      passenger_user_id: req.user.id,
      pickup: data.data.pickup,
      dropoff: data.data.dropoff,
      payment_method: data.data.payment_method,
      note: data.data.note
    });

    // notify online drivers (basic broadcast) + admin
    io.to("drivers").emit("ride_available", { ride });
    io.to("admin").emit("ride_created", { ride });

    res.json({ ok:true, ride });
  });

  router.get("/rides/mine", auth(), (req,res)=>{
    const limit = clamp(Number(req.query.limit||50), 1, 100);
    const rides = (req.user.role === "driver") ? listDriverRides(req.user.id, limit)
                : (req.user.role === "admin") ? searchOpenRides()
                : listPassengerRides(req.user.id, limit);
    res.json({ ok:true, rides });
  });

  router.get("/rides/:id", auth(), (req,res)=>{
    const ride = getRide(req.params.id);
    if (!ride) return res.status(404).json({ ok:false, error:"not_found" });

    // access control: passenger or driver or admin
    if (req.user.role !== "admin" && ride.passenger_user_id !== req.user.id && ride.driver_user_id !== req.user.id) {
      return res.status(403).json({ ok:false, error:"forbidden" });
    }
    res.json({ ok:true, ride });
  });

  // DRIVER: accept ride
  router.post("/rides/:id/accept", auth("driver"), (req,res)=>{
    const ride = acceptRide(req.params.id, req.user.id);
    if (!ride) return res.status(404).json({ ok:false, error:"not_found" });
    io.to(`ride:${ride.id}`).emit("ride_update", { ride });
    io.to("admin").emit("ride_update", { ride });
    res.json({ ok:true, ride });
  });

  router.post("/rides/:id/status", auth(), (req,res)=>{
    const schema = z.object({ status: z.enum(["arrived","started","completed","cancelled"]) , rating: z.number().int().min(1).max(5).optional() });
    const data = schema.safeParse(req.body);
    if (!data.success) return res.status(400).json({ ok:false, error:"bad_input" });

    const ride = getRide(req.params.id);
    if (!ride) return res.status(404).json({ ok:false, error:"not_found" });

    const isPassenger = ride.passenger_user_id === req.user.id;
    const isDriver = ride.driver_user_id === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!isAdmin && !isPassenger && !isDriver) return res.status(403).json({ ok:false, error:"forbidden" });

    const updated = updateRideStatus(ride.id, req.user.role, data.data.status);

    // ratings: after completed
    if (data.data.status === "completed" && data.data.rating) {
      if (isPassenger && ride.driver_user_id) rateUser(ride.driver_user_id, data.data.rating);
      if (isDriver) rateUser(ride.passenger_user_id, data.data.rating);
    }

    io.to(`ride:${ride.id}`).emit("ride_update", { ride: updated });
    io.to("admin").emit("ride_update", { ride: updated });
    res.json({ ok:true, ride: updated });
  });

  // ADMIN
  router.get("/admin/stats", auth("admin"), (req,res)=>{
    res.json({ ok:true, ...adminStats() });
  });

  router.post("/admin/assign", auth("admin"), (req,res)=>{
    const schema = z.object({ ride_id: z.string(), driver_user_id: z.number().int() });
    const data = schema.safeParse(req.body);
    if (!data.success) return res.status(400).json({ ok:false, error:"bad_input" });
    const ride = assignRideToDriver(data.data.ride_id, data.data.driver_user_id);
    if (!ride) return res.status(404).json({ ok:false, error:"not_found" });
    io.to(`user:${data.data.driver_user_id}`).emit("ride_offer", { ride });
    io.to(`ride:${ride.id}`).emit("ride_update", { ride });
    io.to("admin").emit("ride_update", { ride });
    res.json({ ok:true, ride });
  });

  return router;
}
