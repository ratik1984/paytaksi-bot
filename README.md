# PayTaksi — Telegram Taxi Demo (Passenger + Driver + Admin)

Bu layihə 3 Telegram bot + 3 Telegram WebApp (Passenger / Driver / Admin) ilə işləyən **tam işlək demo**-dur.

## Nələr var?
- ✅ Passenger WebApp: qeydiyyat/giriş, xəritədə pick-up & drop seçimi, sifariş yaratmaq, status izləmək, cancel
- ✅ Driver WebApp: qeydiyyat/giriş, online/offline, lokasiya göndərmə, gələn sifariş (offer) qəbul etmə, status dəyişmə, sənəd yükləmə (demo)
- ✅ Admin WebApp: driver approve/reject, pricing settings, trips siyahısı
- ✅ Backend: Node.js + Express + Socket.IO + PostgreSQL
- ✅ Telegram Bots: Telegraf (webhook)

> Qeyd: Bu **demo** layihədə sənəd şəkilləri DB-də base64 kimi saxlanır (production üçün S3/Cloudinary məsləhətdir).

---

## 1) Telegram botları yaratmaq
BotFather ilə 3 bot yaradın:
- Passenger bot: `@PayTaksiPassenger_bot`
- Driver bot: `@PayTaksiDriver_bot`
- Admin bot: `@PayTaksiAdmin2025_bot`

Hər birinin tokenini götürüb `.env`-ə yazın.

**BotFather -> /setdomain**: WebApp istifadə edirsinizsə domeninizi əlavə edin.

---

## 2) Lokal run

```bash
npm install
cp .env.example .env
# .env içində DATABASE_URL, JWT_SECRET, APP_BASE_URL və bot tokenlərini doldurun
npm start
```

Sonra brauzerdə:
- Passenger: `http://localhost:3000/passenger/`
- Driver: `http://localhost:3000/driver/`
- Admin: `http://localhost:3000/admin/`

---

## 3) Render-də deploy

1. GitHub-a push edin.
2. Render-də “New Web Service” -> repo seçin.
3. Build: `npm install`
4. Start: `npm start`
5. Environment variables əlavə edin:
   - `APP_BASE_URL` = Render URL (məs: `https://paytaksi-telegram.onrender.com`)
   - `JWT_SECRET`
   - `DATABASE_URL` (Render Postgres-dən)
   - `DATABASE_SSL=true`
   - `PASSENGER_BOT_TOKEN`, `DRIVER_BOT_TOKEN`, `ADMIN_BOT_TOKEN`
   - `ADMIN_WEB_USER`, `ADMIN_WEB_PASS`

Server ayağa qalxanda botlara webhook avtomatik set olunur.

---

## 4) İş axını (test)
1. Driver qeydiyyatdan keçsin.
2. Admin panelə girib driver-i **Approve** etsin.
3. Driver online olsun + lokasiya göndərsin.
4. Passenger pick-up & drop seçib sifariş yaratsın.
5. Driver-ə offer gələcək, “Qəbul et” ilə götürəcək.

---

## Fayl strukturu
- `index.js` — server + API + sockets
- `src/` — db/auth/pricing/bots
- `public/passenger` — Passenger WebApp
- `public/driver` — Driver WebApp
- `public/admin` — Admin panel
- `sql/init.sql` — DB schema

Uğurlar! 🚕
