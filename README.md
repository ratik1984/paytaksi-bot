# PayTaksi (Telegram) — MVP (Passenger + Driver + Admin)

Bu paket Render + GitHub üçün hazır minimal işlək sistemdir:
- 3 ayrı Telegram bot (Passenger / Driver / Admin)
- PostgreSQL DB (Render Postgres)
- Admin Web panel (`/admin`) — driver təsdiqi, topup təsdiqi, rides siyahısı
- Qiymət hesablaması: **3.50 AZN** baza, **3 km** daxil, sonra **0.40 AZN / km**
- Komissiya: **10%** (gediş bitəndə sürücü balansından çıxılır)
- Balans **-15 AZN** və aşağı düşəndə sürücü sifariş ala bilmir və səbəb göstərilir
- Balans artırma: Card2Card / Terminal / M10 (sürücü qəbz şəkli göndərir, admin təsdiqləyir)
- Naviqasiya: Waze linki (pickup üçün)

> Qeyd: Bu MVP-də “xəritə içində canlı sürücü axtarışı” Telegram Mini App kimi ayrıca UI tələb edir. Bu paketdə bot axını Location ilə işləyir (pulsuz, real işlək).

---

## 1) Lokal test

```bash
npm i
cp .env.example .env
# .env içində DATABASE_URL və bot tokenləri doldurun
npm run init-db
npm run dev
```

## 2) Render-də quraşdırma

1. GitHub-da yeni repo yaradın: `paytaksi-telegram`
2. Bu layihəni repo-ya push edin.
3. Render → **New → Web Service**
4. Repo seçin, runtime: Node
5. Build command: `npm install`
6. Start command: `npm start`
7. Render → **New → PostgreSQL** yaradın və Web Service-ə attach edin.
8. Web Service → **Environment**: `.env.example`-dəki ENV-ləri əlavə edin:
   - `PASSENGER_BOT_TOKEN`
   - `DRIVER_BOT_TOKEN`
   - `ADMIN_BOT_TOKEN`
   - `SUPER_ADMIN_ID`
   - `ADMIN_WEB_USER` / `ADMIN_WEB_PASS`
   - `APP_BASE_URL` = sizin Render URL
   - `DATABASE_URL` Render avtomatik verir (attach edəndən sonra)
9. Deploy edin.

### Admin Web panel
- URL: `https://YOUR-SERVICE.onrender.com/admin`
- Basic Auth: `ADMIN_WEB_USER` / `ADMIN_WEB_PASS`

### Admin Bot
- `/start`
- `/pending_drivers`
- `/approve_driver USER_ID`
- `/pending_topups`
- `/approve_topup TOPUP_ID`

---

## 3) İstifadə axını

### Passenger bot
- `/start`
- `🚕 Taksi sifariş et` → pickup location → destination location

### Driver bot
- `/start` → qeydiyyat wizard (telefon + maşın + sənədlər)
- Admin `approved` edəndən sonra sürücü `🟢 Onlayn ol` seçir
- Sifariş gələndə `✅ Qəbul et`
- `⏹ Gedişi bitir` → ekranda iri/bold qiymət çıxır

---

## 4) DB
Schema: `src/schema.sql`

---

## Növbəti inkişaf ideyaları
- Telegram Mini App (Passenger üçün “Bolt kimi” xəritə UI)
- Driver canlı lokasiya + yaxın sürücüyə görə paylama
- Promo/kupon, surge, tarif kateqoriyaları
- Audit log + geniş statistika
