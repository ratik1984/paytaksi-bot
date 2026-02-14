
import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

let rides = [];

// Create ride (only one active allowed)
app.post("/ride/create", (req, res) => {
  const { user_id, from, to } = req.body;

  const active = rides.find(r => r.user_id === user_id && r.status === "active");
  if (active) {
    return res.status(409).json({
      ok: false,
      error: "active_ride_exists",
      ride_id: active.id,
      status: active.status
    });
  }

  const newRide = {
    id: rides.length + 1,
    user_id,
    from,
    to,
    status: "active"
  };

  rides.push(newRide);

  return res.json({ ok: true, ride: newRide });
});

// Cancel ride
app.post("/ride/cancel", (req, res) => {
  const { ride_id } = req.body;

  const ride = rides.find(r => r.id === ride_id);
  if (!ride) {
    return res.status(404).json({ ok: false, error: "ride_not_found" });
  }

  ride.status = "cancelled";
  return res.json({ ok: true, message: "Ride cancelled" });
});

app.get("/", (req, res) => {
  res.send("PayTaksi server running");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
