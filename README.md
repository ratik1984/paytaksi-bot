# PayTaksi (Telegram-only) — Passenger + Driver + Admin

This repo is a working MVP for a Bolt-like taxi workflow **inside Telegram**, using **3 separate bots** and **Telegram WebApp** pages.

## What you get
- Passenger WebApp: map, destination search (free), quote, create order
- Driver WebApp: online/offline, live location, receive offers, accept/reject, start/end trip, big final fare screen
- Admin WebApp: approve drivers, edit pricing
- 3 bots:
  - Passenger bot opens Passenger WebApp
  - Driver bot runs registration wizard + opens Driver WebApp
  - Admin bot opens Admin WebApp + approve via commands

## Deploy (Render)
1. Create **Render Postgres** and copy `DATABASE_URL`.
2. Create **Render Web Service** from GitHub repo.
3. Root directory: `server`
4. Build command: *(none)*
5. Start command: `npm start`
6. Add env vars (see `server/.env.example`).

## Local run
```bash
cd server
cp .env.example .env
npm i
npm start
```

Open:
- Passenger: `http://localhost:10000/p/`
- Driver: `http://localhost:10000/d/`
- Admin: `http://localhost:10000/a/`

> NOTE: For security, production should validate Telegram `initData`. This MVP can run with `ALLOW_TG_UNSAFE=1`.
