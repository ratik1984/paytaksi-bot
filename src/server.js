
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (public folder)
app.use(express.static(path.join(__dirname, "public")));

// Basic health check
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// ===== SOCKET.IO SETUP =====
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

let onlineDrivers = {};

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Driver comes online
  socket.on("driver-online", (data) => {
    onlineDrivers[data.driverId] = {
      socketId: socket.id,
      lat: data.lat,
      lng: data.lng
    };
    console.log("Driver online:", data.driverId);
  });

  // Driver location update
  socket.on("driver-location", (data) => {
    if (onlineDrivers[data.driverId]) {
      onlineDrivers[data.driverId].lat = data.lat;
      onlineDrivers[data.driverId].lng = data.lng;

      io.emit("driver-update", {
        driverId: data.driverId,
        lat: data.lat,
        lng: data.lng
      });
    }
  });

  // Passenger creates order
  socket.on("create-order", (order) => {
    const drivers = Object.values(onlineDrivers);
    if (drivers.length === 0) {
      console.log("No online drivers available");
      return;
    }

    // Simple nearest logic placeholder
    const nearest = drivers[0];

    io.to(nearest.socketId).emit("new-order", order);
  });

  socket.on("disconnect", () => {
    for (const id in onlineDrivers) {
      if (onlineDrivers[id].socketId === socket.id) {
        delete onlineDrivers[id];
        console.log("Driver disconnected:", id);
      }
    }
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
