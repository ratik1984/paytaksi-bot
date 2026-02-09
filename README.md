# PayTaksi — Telegram Bot + Mini App (Canlı xəritə)

Bu ZIP: bot + miniapp + admin panel hamısı bir yerdədir.

## Lokal
npm install
cp .env.example .env
# BOT_TOKEN yaz
npm start

## Render deploy
Env vars:
BOT_TOKEN
ADMIN_IDS=1326729201
PUBLIC_BASE_URL=https://<render-url>
WEBHOOK_SECRET=paytaksi_bot

## BotFather
/setdomain -> PUBLIC_BASE_URL
/setmenubutton -> https://<PUBLIC_BASE_URL>/webapp

## Dev test (Telegram olmadan)
http://localhost:3000/webapp?dev=1&user_id=1326729201
http://localhost:3000/admin?dev=1&user_id=1326729201
