# PayTaksi (Working) — 3 ayrı Telegram Bot + Admin Panel (Render)

Admin panel login:
- Login: Ratik
- Parol: 0123456789

## Render-də quraşdırma
1) GitHub-a push edin
2) Render → New → PostgreSQL yaradın, DATABASE_URL götürün
3) Render → New → Web Service → repo seçin
   - Build Command:
     npm install
     npm run build
   - Start Command:
     npm start
4) Environment Variables:
   DATABASE_URL
   BOT_PASSENGER_TOKEN
   BOT_DRIVER_TOKEN
   BOT_ADMIN_TOKEN
   ADMIN_PANEL_USER=Ratik
   ADMIN_PANEL_PASS=0123456789
   SESSION_SECRET=uzun_random

Admin panel: https://<service>.onrender.com/admin
