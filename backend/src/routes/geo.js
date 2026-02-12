import { Router } from "express";

const router = Router();
const PHOTON = process.env.PHOTON_BASE || "https://photon.komoot.io";

router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const lat = req.query.lat ? Number(req.query.lat) : null;
  const lng = req.query.lng ? Number(req.query.lng) : null;
  if (!q || q.length < 3) return res.json({ features: [] });

  const url = new URL(PHOTON + "/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "8");
  url.searchParams.set("lang", "en");
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
  }

  const r = await fetch(url.toString(), {
    headers: {
      "User-Agent": "PayTaksi-v2 (Render) - contact: admin@paytaksi.local"
    }
  });
  const data = await r.json();
  res.json(data);
});

router.get("/reverse", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat/lng required" });
  }
  const url = new URL(PHOTON + "/reverse/");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("lang", "en");
  const r = await fetch(url.toString(), {
    headers: { "User-Agent": "PayTaksi-v2 (Render) - contact: admin@paytaksi.local" }
  });
  const data = await r.json();
  res.json(data);
});

export default router;
