# PayTaksi (Telegram Mini App + 3 Bots)

Bu repoda 3 ayrı Telegram bot var:
- Passenger bot (sərnişin)
- Driver bot (sürücü)
- Admin bot

Hamısı **Webhook** ilə işləyir.

## 1) Render (Web Service)
1. GitHub repo-ya bütün faylları yüklə.
2. Render → New → Web Service → repo seç.
3. Environment variables əlavə et:
   - APP_BASE_URL = https://<service>.onrender.com
   - WEBHOOK_SECRET = istənilən gizli söz (məs: 0123456789)
   - PASSENGER_BOT_TOKEN
   - DRIVER_BOT_TOKEN
   - ADMIN_BOT_TOKEN
   - DATABASE_URL (Render Postgres verirsə avtomatik gəlir)

## 2) Telegram Webhook
Server start olanda webhook-ları özü set edir:
- /webhook/<SECRET>/passenger
- /webhook/<SECRET>/driver
- /webhook/<SECRET>/admin

Əl ilə yoxlama üçün:
GET /health

## 3) DB
`db/schema.sql` faylını Postgres-də icra et.

## 4) Mini App
Sərnişin/ sürücü/ admin botda `/start` → WebApp düyməsi çıxır.

