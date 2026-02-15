PayTaksi Full Dispatch Aktiv Patch (debug helpers)

Bu patch aşağıdakı problemləri həll edir:
- Browser-dən (Telegram WebApp olmadan) test üçün debug driver online + location endpoint-ləri.
- /app/passenger/api/debug/... kimi köhnə URL-lərə redirect (Cannot GET problemini aradan qaldırır).

Quraşdırma:
1) ZIP-i layihənin kökünə çıxarın (src/server.js overwrite olacaq).
2) Render -> Environment-də DEBUG_KEY dəyəri qoyun (məs: 12345).
3) Deploy-dan sonra test:
   - DB migrate: /api/debug/db_migrate?debug_key=DEBUG_KEY
   - Driver online: /api/driver/set_online?driver_id=1&online=1&debug_key=DEBUG_KEY
   - Driver ping+location: /api/debug/driver_ping?driver_id=1&lat=40.4093&lon=49.8671&online=1&debug_key=DEBUG_KEY
   - Nearby: /api/debug/nearby_drivers?lat=40.4093&lon=49.8671&radius_km=3&debug_key=DEBUG_KEY

Qeyd: Real sistemdə sürücü və sərnişin Telegram WebApp içindən POST endpoint-lər ilə işləməlidir.
