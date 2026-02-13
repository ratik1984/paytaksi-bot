PayTaksi REAL SYSTEM (Telegram initData secure verify + auto user register + ride create)

Bu paket nə verir:
✅ Backend: /api/verify-telegram (BOT_TOKEN ilə initData HMAC verify)
✅ Auto user register/update: tg_users
✅ Ride create endpoint: POST /api/rides (DB varsa rides cədvəlinə yazır)
✅ Frontend: WebApp backend verify çağırır (unknown problemi YOX)

Quraşdırma (Render):
1) server qovluğunu layihənə əlavə et (və ya mövcud backendin içində bu faylları merge et).
2) Render env variables:
   - BOT_TOKEN = (BotFather verdiyi bot token)
   - DATABASE_URL = (Render Postgres URL)  [istəyə bağlı]
   - PGSSL = true   (Render Postgres üçün çox vaxt lazımdır)
3) Start command: npm start
4) WebApp faylları:
   - Bu paketdə webapp/index.html var.
   - İstəsən server də verə bilər: server/public/webapp/ altına qoyub /webapp/ kimi serve et.
   - BotFather WebApp URL:
     https://<sənin-domain>/webapp/?from=passenger

Test:
- Telegram WebApp aç -> Verified ✅ görməlisən.
- Ride demo üçün coords yazıb "Ride yarat" bas.

Növbəti addım:
- OSRM route (mesafe/vaxt) + qiymət + 10% komissiya
- Driver qeydiyyat + canlı xəritə + paylama mexanizmi
