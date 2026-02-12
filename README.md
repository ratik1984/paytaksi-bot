# PayTaksi v2 (Telegram Mini App) — Modern + Workable

Bu paket PayTaksi-nin v2 versiyasıdır: **pulsuz xəritə (OSM)**, **işlək ünvan autocomplete (Photon)**, **real-time sifariş (Socket.IO)**, sürücü sənədləri və geniş admin panel.

## Arxitektura
- Backend: Node.js + Express + Prisma + PostgreSQL + Socket.IO
- Frontend: React (Vite) + Leaflet (OSM)
- Geocoding: Photon (public endpoint `https://photon.komoot.io`) via backend proxy (`/geo/*`)

## Render qurulumu (manual)
### 1) PostgreSQL
Render → New → PostgreSQL → create
Copy: **Internal Database URL**

### 2) Backend (Web Service)
Render → New → Web Service
- Repo root: `backend`
- Build: `npm install`
- Start: `npm start`

Env vars:
- `DATABASE_URL` = Postgres Internal URL
- `JWT_SECRET` = random uzun secret
- `ADMIN_LOGIN` = `Ratik`
- `ADMIN_PASSWORD` = `0123456789`
- (optional) `PHOTON_BASE` = `https://photon.komoot.io`

### 3) Frontend (Static Site)
Render → New → Static Site
- Root: `frontend`
- Build: `npm install && npm run build`
- Publish: `dist`

Env vars:
- `VITE_API_BASE` = backend URL (https://...onrender.com)

### 4) Telegram BotFather
- `/setdomain` → `frontend-domain.onrender.com` (https yazmadan)
- `/setmenubutton` → URL: `https://frontend-domain.onrender.com`

## Admin panel
Frontend → `/admin`
Login: `Ratik`
Parol: `0123456789`

## Qeyd
- Sürücü statusu **APPROVED** olmadan online ola bilməz.
- Komissiya ride `COMPLETED` olanda sürücünün balansından çıxılır.
