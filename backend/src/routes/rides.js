import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../lib/auth.js";

const router = Router();

async function getSettingFloat(key, fallback) {
  const s = await prisma.setting.findUnique({ where: { key } });
  const v = s ? parseFloat(s.value) : fallback;
  return Number.isFinite(v) ? v : fallback;
}

function calcFare(distanceKm, startFare, freeKm, perKmAfter) {
  let fare = startFare;
  if (distanceKm > freeKm) {
    fare += (distanceKm - freeKm) * perKmAfter;
  }
  return Math.round(fare * 100) / 100;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

router.get("/mine", requireAuth, async (req, res) => {
  const role = req.user.role;
  const where = role === "DRIVER"
    ? { driverId: req.user.uid }
    : { passengerId: req.user.uid };
  const rides = await prisma.ride.findMany({ where, orderBy: { createdAt: "desc" }, take: 30 });
  res.json({ rides });
});

router.post("/create", requireAuth, async (req, res) => {
  if (req.user.role !== "PASSENGER") {
    // allow drivers to create as passenger if needed
    await prisma.user.update({ where: { id: req.user.uid }, data: { role: "PASSENGER" } });
  }

  const body = z.object({
    pickupLat: z.number(),
    pickupLng: z.number(),
    pickupText: z.string().optional(),
    dropLat: z.number(),
    dropLng: z.number(),
    dropText: z.string().optional()
  }).parse(req.body);

  const distanceKm = haversineKm(body.pickupLat, body.pickupLng, body.dropLat, body.dropLng);

  const startFare = await getSettingFloat("startFare", 3.5);
  const freeKm = await getSettingFloat("freeKm", 3.0);
  const perKmAfter = await getSettingFloat("perKmAfter", 0.40);
  const commissionRate = await getSettingFloat("commissionRate", 0.10);

  const fareAzN = calcFare(distanceKm, startFare, freeKm, perKmAfter);
  const commissionAzN = Math.round(fareAzN * commissionRate * 100) / 100;

  const ride = await prisma.ride.create({
    data: {
      passengerId: req.user.uid,
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      pickupText: body.pickupText,
      dropLat: body.dropLat,
      dropLng: body.dropLng,
      dropText: body.dropText,
      distanceKm,
      fareAzN,
      commissionAzN,
      status: "REQUESTED"
    }
  });

  // broadcast offer to nearby drivers
  req.app.locals.broadcastRideOffer(ride.id);

  // notify passenger via socket
  req.app.locals.io.to(`passenger:${req.user.uid}`).emit("ride_update", { rideId: ride.id, status: ride.status, ride });

  res.json({ ok: true, ride });
});

router.post("/accept", requireAuth, async (req, res) => {
  if (req.user.role !== "DRIVER") return res.status(403).json({ error: "DRIVER_ONLY" });

  const body = z.object({ rideId: z.string() }).parse(req.body);

  const driver = await prisma.driverProfile.findUnique({ where: { userId: req.user.uid } });
  if (!driver) return res.status(400).json({ error: "REGISTER_FIRST" });
  if (driver.status !== "APPROVED") return res.status(403).json({ error: "NOT_APPROVED" });

  const minBal = parseFloat((await prisma.setting.findUnique({ where: { key: "driverMinBalance" } }))?.value ?? "-10");
  if (driver.balance <= minBal) return res.status(403).json({ error: "LOW_BALANCE", min: minBal });

  const ride = await prisma.ride.findUnique({ where: { id: body.rideId } });
  if (!ride) return res.status(404).json({ error: "NOT_FOUND" });
  if (ride.status === "ACCEPTED" || ride.driverId) return res.status(409).json({ error: "ALREADY_TAKEN" });

  const updated = await prisma.ride.update({
    where: { id: ride.id },
    data: { driverId: req.user.uid, status: "ACCEPTED" }
  });

  // notify both
  req.app.locals.io.to(`driver:${req.user.uid}`).emit("ride_update", { rideId: updated.id, status: updated.status, ride: updated });
  req.app.locals.io.to(`passenger:${updated.passengerId}`).emit("ride_update", { rideId: updated.id, status: updated.status, ride: updated });

  res.json({ ok: true, ride: updated });
});

router.post("/status", requireAuth, async (req, res) => {
  const body = z.object({
    rideId: z.string(),
    status: z.enum(["ARRIVED","IN_RIDE","COMPLETED","CANCELED"])
  }).parse(req.body);

  const ride = await prisma.ride.findUnique({ where: { id: body.rideId } });
  if (!ride) return res.status(404).json({ error: "NOT_FOUND" });

  // permission: passenger can cancel; driver can progress
  const isPassenger = ride.passengerId === req.user.uid;
  const isDriver = ride.driverId === req.user.uid;

  if (body.status === "CANCELED" && !isPassenger) return res.status(403).json({ error: "PASSENGER_ONLY" });
  if (["ARRIVED","IN_RIDE","COMPLETED"].includes(body.status) && !isDriver) return res.status(403).json({ error: "DRIVER_ONLY" });

  const updated = await prisma.ride.update({ where: { id: ride.id }, data: { status: body.status } });

  // on complete: apply commission to driver balance (subtract 10%)
  if (body.status === "COMPLETED" && updated.driverId) {
    const commission = updated.commissionAzN ?? 0;
    await prisma.driverProfile.update({
      where: { userId: updated.driverId },
      data: { balance: { decrement: commission } }
    });
  }

  req.app.locals.io.to(`passenger:${updated.passengerId}`).emit("ride_update", { rideId: updated.id, status: updated.status, ride: updated });
  if (updated.driverId) req.app.locals.io.to(`driver:${updated.driverId}`).emit("ride_update", { rideId: updated.id, status: updated.status, ride: updated });

  res.json({ ok: true, ride: updated });
});

export default router;
