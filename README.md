# PayTaksi (Telegram Mini App) — MVP

Bu ZIP-də **sərnişin**, **sürücü** və **admin panel** olan ilkin işlək sistem var.

## Funksiyalar (sizin istəklərə uyğun)
- Proqram adı: **PayTaksi**
- Komissiya: **10%** (admin paneldən dəyişmək olar)
- Qiymət: **Start 3.50 AZN**, **3 km-dən sonra hər 1 km = 0.40 AZN** (setting-lərdədir)
- Sərnişin: avtomatik GPS, gedəcəyiniz yer yazanda **alternativ yaxın yerlər** (OSM Nominatim)
- Sürücü qeydiyyatı: **minimum buraxılış ili 2010**, rəng məhdudiyyətləri **aq,qara,qirmizi,boz,mavi,sari,yashil**
- Sürücü sənədləri: Ş/V (ön/arxa), S/V (ön/arxa), Texniki pasport (ön/arxa) yükləmə
- Balans: sürücü balansı görür, **kart-to-kart** və **M10** ilə top-up sorğusu yaradır, admin təsdiqləyir
- Driver balance **-10 AZN və aşağı** olanda sifariş ala bilmir
- Admin panel: sürücülər, sənədlər approve/reject, top-up approve/reject, qiymət/komissiya setting-ləri

> Qeyd: Real kart-to-kart/M10 API inteqrasiyası bu MVP-də yoxdur — **top-up sorğusu** logikası var, admin təsdiq edir.

---

## Lokal qurulum

### 1) Backend
```bash
cd backend
npm i
cp .env.example .env
# DATABASE_URL və TELEGRAM_BOT_TOKEN doldurun
npm run prisma:generate
npx prisma migrate dev --name init
npm run dev
```
Backend default: http://localhost:3000

### 2) Frontend (Telegram Mini App UI)
```bash
cd frontend
npm i
cp .env.example .env
npm run dev
```
Frontend default: http://localhost:5173

---

## Env (backend/.env)
- `DATABASE_URL` — Postgres
- `JWT_SECRET` — JWT üçün
- `TELEGRAM_BOT_TOKEN` — Telegram Bot token (initData validate üçün)
- `ADMIN_LOGIN` / `ADMIN_PASSWORD` — admin panel login (frontend-də /admin-login)
- `CORS_ORIGIN` — lazım olsa `https://your-frontend-domain` (və ya bir neçə domen csv)
- `UPLOAD_DIR` — sənədlər üçün qovluq (default `uploads`)

## Render + GitHub
1) Bu layihəni GitHub repo kimi yükləyin (monorepo).
2) Render-də Postgres yaradın, `DATABASE_URL` alın.
3) Backend: new Web Service → root: `backend`
   - Build: `npm i && npm run prisma:generate && npm run prisma:migrate`
   - Start: `npm start`
   - Env: `DATABASE_URL`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `ADMIN_LOGIN`, `ADMIN_PASSWORD`
4) Frontend: new Static Site → root: `frontend`
   - Build: `npm i && npm run build`
   - Publish: `dist`
   - Env: `VITE_API_BASE=https://<your-backend>.onrender.com`
5) Telegram BotFather → WebApp url: frontend domeninizi yazın.

---

## Növbəti addımlar (istəsəniz əlavə edərik)
- Real map routing (OSRM/Google) ilə dəqiq km
- Real ödəniş inteqrasiyası (M10 API / bank) + avtomatik balans
- Ride matching (socket) + push bildirişlər
- Tariflər (gecə/gündüz), surge, promo kod
- Sürücü verifikasiyası tam workflow + audit log

