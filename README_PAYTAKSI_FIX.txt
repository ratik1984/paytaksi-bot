PayTaksi Patch: Passenger Nearby Drivers + Debug DB/MAP helpers

Bu patch nə edir:
1) Passenger üçün canlı maşınlar endpointi əlavə edir:
   GET /api/passenger/nearby_drivers?lat=...&lon=...&radius_km=3

2) Debug üçün 2 endpoint (Telegram tələb etmir, DEBUG_KEY ilə qorunur):
   - GET /api/debug/db_migrate?debug_key=YOUR_KEY
     (DB-də lazım olan əlavə kolonları IF NOT EXISTS ilə yaradır)

   - GET /api/debug/nearby_drivers?lat=...&lon=...&radius_km=3&debug_key=YOUR_KEY

Vacib:
- Render Environment Variables bölməsində DEBUG_KEY əlavə et (məs: 12345).
- Sonra servis redeploy olsun.

Quraşdırma:
- ZIP içindəki faylı layihəndə eyni yol ilə kopyala:
  src/server.js

