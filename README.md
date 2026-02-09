# PayTaksi Bot (Telegram Mini App) — Full MVP

Bu repozitoriyada 3 ayrı “mobil tətbiq” kimi işləyən PWA var:

- **/p/** — Sərnişin (sifariş verir, xəritə, tarixçə, reytinq)
- **/d/** — Sürücü (online/offline, canlı lokasiya, sifariş pop-up “zəng kimi”, Waze/Google naviqasiya)
- **/admin/** — Admin panel (statistika, open rides, sürücüyə assign, canlı nəzarət)

Backend: **Node.js + Express + Socket.IO + Telegraf**  
DB: **SQLite (better-sqlite3)**

## Env

`.env.example` faylını `.env` edin və dəyərləri doldurun:

- `BOT_TOKEN`
- `PUBLIC_BASE_URL` (Render URL)
- `WEBHOOK_SECRET` (məs: paytaksi_bot)
- `ADMIN_IDS=1326729201` (vergül ilə çox admin ola bilər)

## Local run

```bash
npm i
npm run dev
```

Sonra botda `/start` yazın, mini-app düymələri çıxacaq.

## Render deploy

Render-də **Web Service** yaradın:

- Build Command: `npm install`
- Start Command: `npm start`
- Env vars: yuxarıdakı `.env` dəyərləri

Webhook avtomatik `PUBLIC_BASE_URL/bot/WEBHOOK_SECRET` ünvanına qurulur.

> Qeyd: xəritə üçün OSM/Leaflet CDN istifadə olunur. Ünvan axtarışı Nominatim ilə edilir.

## Təhlükəsizlik

- WebApp auth: Telegram `initData` hash yoxlanılır.
- Admin giriş: `ADMIN_IDS` Telegram user id siyahısı ilə.
