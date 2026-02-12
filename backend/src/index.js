import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import http from "http";
import { Server } from "socket.io";

import { bootstrap } from "./lib/bootstrap.js";
import { prisma } from "./lib/prisma.js";
import { requireAuth } from "./lib/auth.js";
import geoRoutes from "./routes/geo.js";
import authRoutes from "./routes/auth.js";
import driverRoutes from "./routes/driver.js";
import rideRoutes from "./routes/rides.js";
import adminRoutes from "./routes/admin.js";
import { haversineKm } from "./lib/geo.js";
import { CONFIG } from "./lib/config.js";

const app = express();

app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS: allow Telegram WebApp (often "null" origin)
app.use(cors({
  origin: true,
  credentials: true
}));

app.get("/", (req, res) => res.status(200).send("PayTaksi v2 API is running"));
app.get("/health", async (req, res) => {
  const db = await prisma.$queryRaw`SELECT 1 as ok`;
  res.json({ ok: true, db, ts: Date.now() });
});

app.use("/uploads", express.static(new URL("../uploads", import.meta.url).pathname));

app.use("/geo", geoRoutes);
app.use("/auth", authRoutes);
app.use("/driver", driverRoutes);
app.use("/rides", rideRoutes);
app.use("/admin", adminRoutes);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

// Socket rooms:
// - "drivers" for driver broadcast
// - "driver:<userId>" for individual driver
// - "passenger:<userId>" for passenger updates
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("join", ({ role, userId }) => {
    console.log("socket join", { role, userId });

    if (role === "DRIVER") {
      socket.join("drivers");
      socket.join(`driver:${userId}`);
    } else if (role === "PASSENGER") {
      socket.join(`passenger:${userId}`);
    }
  });
});

// Helper: broadcast ride offer to nearby approved drivers
async function broadcastRideOffer(rideId) {
  const ride = await prisma.ride.findUnique({ where: { id: rideId } });
  if (!ride) return;

  // candidate drivers: approved + balance > min
  const minBal = parseFloat((await prisma.setting.findUnique({ where: { key: "driverMinBalance" } }))?.value ?? String(CONFIG.driverMinBalance));
  const drivers = await prisma.driverProfile.findMany({
    where: { status: "APPROVED", balance: { gt: minBal } },
    select: { userId: true, id: true }
  });

  // load latest location for each driver (simple approach)
  const offers = [];
  for (const d of drivers) {
    const loc = await prisma.driverLocation.findFirst({
      where: { driverId: d.id },
      orderBy: { createdAt: "desc" }
    });
    if (!loc) continue;
    const dist = haversineKm(ride.pickupLat, ride.pickupLng, loc.lat, loc.lng);
    if (dist <= 6) { // 6 km radius
      offers.push({ userId: d.userId, dist });
    }
  }
  offers.sort((a,b)=>a.dist-b.dist);
  const top = offers.slice(0, 30); // max 30 drivers ping

  for (const o of top) {
    io.to(`driver:${o.userId}`).emit("ride_offer", { rideId, distanceKm: o.dist });
  }

  await prisma.ride.update({ where: { id: rideId }, data: { status: "OFFERED" } });
}

// Expose for routes
app.locals.io = io;
app.locals.broadcastRideOffer = broadcastRideOffer;

const PORT = process.env.PORT || 3000;

await bootstrap();
server.listen(PORT, () => console.log(`PayTaksi v2 backend listening on ${PORT}`));
