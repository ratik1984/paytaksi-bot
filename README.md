# PayTaksi — FULL Starter (MVP+)

Includes:
- Passenger Mini App (Telegram WebApp)
- Driver Mini App (Telegram WebApp)
- Admin Panel
- Backend API + Socket.IO real-time
- PostgreSQL schema

Pricing:
- Base 3.50 AZN
- After 3 km: 0.40 AZN / km
- Commission: 10%
- Driver blocked if wallet_balance < -10

## Local run
1) Create Postgres DB `paytaksi`
2) Run SQL:
   - backend/sql/schema.sql
   - backend/sql/seed.sql
3) Backend:
```bash
cd backend
cp .env.example .env
npm i
npm run dev
```
Backend: http://localhost:8080

4) Open:
- miniapp-passenger/index.html
- miniapp-driver/index.html
- admin/index.html

Edit `config.js` files for BACKEND_BASE_URL and API_KEY.

## Render
Deploy backend as Web Service (Node) + Postgres.
Frontends can be static sites.
