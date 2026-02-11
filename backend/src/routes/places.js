import express from 'express';

const router = express.Router();

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 3) return res.json({ items: [] });

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '5');
  url.searchParams.set('q', q);

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'PayTaksi/0.1 (contact: admin@example.com)'
      }
    });
    const data = await r.json();
    const items = Array.isArray(data)
      ? data.map((x) => ({
          display: x.display_name,
          lat: parseFloat(x.lat),
          lng: parseFloat(x.lon)
        }))
      : [];
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
