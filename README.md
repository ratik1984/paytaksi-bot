# PayTaksi (Render Free Ready)

## GitHub
1) Bu ZIP-i aç
2) Repo-da (ratik1984/paytaksi-bot) köhnə faylları sil və bu faylları upload et
3) Commit et

## Render (Blueprint)
- New Blueprint Instance -> repo seç -> render.yaml
- Deploy

## Render ENV (paytaksi-api -> Environment)
- PUBLIC_BASE_URL = https://paytaksi-api.onrender.com  (öz URL)
- API_BASE = eyni
- PASSENGER_BOT_TOKEN / DRIVER_BOT_TOKEN / ADMIN_BOT_TOKEN = BotFather tokenləri (istəyə görə)
- ADMIN_USERNAME = Ratik
- ADMIN_PASSWORD = 0123456789

## Test
- https://<service>.onrender.com/  -> status
- https://<service>.onrender.com/webapp/?from=passenger
- https://<service>.onrender.com/admin  (login)
