
// STABLE JSON PARSE FIX (PRO VERSION)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// SAFE JSON PARSER
app.use(express.json({
  limit: "1mb"
}));

// JSON ERROR HANDLER
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.get("/", (req, res) => {
  res.send("PayTaksi PRO Server Live");
});

// STABLE CREATE RIDE
app.post("/api/create-ride", (req, res) => {
  const { pickup, destination, price } = req.body || {};

  if (!pickup || !destination) {
    return res.status(400).json({ error: "Missing pickup or destination" });
  }

  const ride = {
    id: Date.now(),
    pickup,
    destination,
    price: price || 0,
    status: "searching"
  };

  io.emit("ride_created", ride);

  return res.json({ success: true, ride });
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("PayTaksi PRO server listening on", PORT);
});
