# PayTaksi Telegram Bot

Tam paket: **Sərnişin + Sürücü + Admin**.

## Start

```bash
npm i
cp .env.example .env
# BOT_TOKEN və ADMIN_IDS doldur
node index.js
```

## Admin
- `/admin` panel (Telegram içindən)
- sürücü təsdiqlə / blokla
- tarifləri və qiymət hesabını dəyiş
- aktiv sifarişləri izlə, force-cancel
- broadcast, audit log

## Qeyd
- DB: `data.sqlite` (SQLite)
- Geocode: OSM Nominatim (istəsən `.env`-də söndür)

