# PayTaksi bot WebApp fix (V3)

This patch makes the "PayTaksi-ni aç" button a REAL Telegram WebApp button (web_app),
so it opens inside Telegram instead of Google/Browser.

## How to apply
1) Replace your repo file: apps/bot/src/index.js with this one.
2) Commit + push to GitHub.
3) Render: deploy the BOT service (the one that runs the bot).
4) Ensure env vars:
   - BOT_TOKEN
   - WEBAPP_URL=https://paytaksi-web.onrender.com
5) Telegram: open bot, send /start, then tap "PayTaksi-ni aç (V3)".
