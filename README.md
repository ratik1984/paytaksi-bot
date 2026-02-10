# PayTaksi (Telegram Mini App + Bot + API + Admin) — Full System (MVP+)

This repository is a **working starter** for a Bolt-like taxi ordering system built for **Telegram Mini Apps**:
- Passenger + Driver WebApp (Telegram Mini App)
- Admin Panel
- Backend API (REST) + Real-time (Socket.IO)
- Telegram Bot (opens the Mini App)

> NOTE: For maps + place autocomplete you must provide a provider key (Mapbox recommended).
> The app runs without keys, but the map UI will show a placeholder.

## Tech
- Node.js 18+ (API + Bot)
- Postgres (Render Postgres recommended)
- React (Vite) for WebApp + Admin

## Monorepo structure
- `apps/api` — Fastify API + Socket.IO + Postgres
- `apps/bot` — grammY bot to launch Mini App
- `apps/web` — Telegram Mini App UI (Passenger + Driver)
- `apps/admin` — Admin Panel UI

## Quick start (local)
1. Install Node 18+, Postgres 14+
2. Create DB and set `DATABASE_URL` in `.env` files.
3. From repo root:
   ```bash
   npm i
   npm run db:migrate
   npm run dev
   ```
4. Open:
   - API: http://localhost:8080/health
   - Web: http://localhost:5173
   - Admin: http://localhost:5174

## Environment variables
Copy `.env.example` into each app:
- `apps/api/.env`
- `apps/bot/.env`
- `apps/web/.env`
- `apps/admin/.env`

## Pricing formula
- Start fare: 3.50 AZN
- First 3 km included
- After 3 km: 0.40 AZN / km

`fare = 3.50 + max(0, distance_km - 3) * 0.40`

## Telegram
- Create bot with @BotFather, set:
  - Web App URL (your deployed web)
  - Domain allowed
- Put bot token in `apps/bot/.env` and `apps/api/.env`
- Set `ADMIN_TG_ID=1326729201`

## Deploy (Render)
Use `render.yaml` in repo root. It creates:
- API (web service)
- Bot (worker)
- WebApp (static)
- Admin (static)

---

## Security note (important)
Telegram Mini Apps send `initData`. Backend must verify signature using bot token.
This repo implements verification (see `apps/api/src/telegram/verifyInitData.js`).

