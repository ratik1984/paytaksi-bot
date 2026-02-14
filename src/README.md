# PayTaksi Bot (Stable)

Bu ZIP PayTaksi Telegram bot serverinin STABIL versiyasıdır (Render üçün uyğundur).
Əsas məqsəd: botların /start-a cavab verməsi və webhook 404 probleminin olmaması.

## Render ENV
Minimum (tək bot):
- BOT_TOKEN = <TOKEN>
- WEBHOOK_SECRET = 0123456789
- APP_BASE_URL = https://<service>.onrender.com

3 bot:
- PASSENGER_BOT_TOKEN = ...
- DRIVER_BOT_TOKEN = ...
- ADMIN_BOT_TOKEN = ...
- WEBHOOK_SECRET = 0123456789
- APP_BASE_URL = https://<service>.onrender.com

## Manual setWebhook
Passenger:
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<DOMAIN>/webhook/<SECRET>/passenger

Driver:
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<DOMAIN>/webhook/<SECRET>/driver

Admin:
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<DOMAIN>/webhook/<SECRET>/admin

## Test komandaları
Passenger: /start, /order, /cancel, msg: salam
Driver: /start, /accept 1, msg: salam
Admin: /start, /stats

## Qeyd
Browser-də /webhook açanda artıq "Cannot GET /webhook" görməyəcəksən.
Telegram POST edir, browser GET edir — bu versiya hər ikisini 200 ilə qarşılayır.
