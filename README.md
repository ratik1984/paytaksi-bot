# PayTaksi (Telegram Taxi System) — 3 bot + Admin Panel (Render + GitHub)

Bu paket **sıfırdan işlək MVP** sistemdir:
- **@PayTaksiPassenger_bot** (müştəri) — sifariş verir
- **@PayTaksiDriver_bot** (sürücü) — sifariş qəbul edir, gedişi başlayıb/bitirir, balans görür
- **@PayTaksiAdmin_bot** (admin) — admin panel linki və qısa baxış
- **Admin Panel (Web)** — sürücü təsdiqi, qəbz təsdiqi, balans düzəlişi, gedişlər, ledger.

> Dizayn “Bolt stili” kimi sadə, qaranlıq admin UI ilə verilib. Telegram bot interfeysi Bolt-un əsas axınına bənzəyir.

---

## 1) Quraşdırma (lokal test)

1. Node.js 18+ qurun.
2. PostgreSQL yaradın (lokal və ya Render).
3. `.env.example` faylını `.env` edib dəyərləri yazın.
4. Paketləri yükləyin:

```bash
npm install
npm start
```

Server işləyəndə konsolda `PayTaksi server on :PORT` görəcəksiniz.

---

## 2) Render + GitHub ilə Deploy (tam addım-addım)

### A) GitHub-a yüklə
1. Bu qovluğu repo edin (PayTaksi).
2. GitHub-a push edin.

### B) Render-də Web Service aç
1. Render → **New → Web Service**
2. GitHub repo seç
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Environment Variables (ENV) əlavə et:
   - `PUBLIC_BASE_URL` = Render URL (məs: `https://paytaksi.onrender.com`)
   - `PASSENGER_BOT_TOKEN`
   - `DRIVER_BOT_TOKEN`
   - `ADMIN_BOT_TOKEN`
   - `DATABASE_URL` (Render Postgres verəcək)
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD_HASH`
   - `SESSION_SECRET`

### C) Render Postgres aç
1. Render → **New → PostgreSQL**
2. `DATABASE_URL`-u Web Service ENV-ə yaz.

### D) BotFather webhook
Bu layihə avtomatik `setWebhook` edir (PUBLIC_BASE_URL varsa). 
Yenə də yoxlama üçün BotFather-da webhook manual qoymaq istəsəniz:

- Passenger webhook: `PUBLIC_BASE_URL + /webhook/passenger/<token_prefix>`
- Driver webhook: `PUBLIC_BASE_URL + /webhook/driver/<token_prefix>`
- Admin webhook: `PUBLIC_BASE_URL + /webhook/admin/<token_prefix>`

`token_prefix` — tokenin `:`-dan əvvəlki hissəsidir (məs: `123456789`).

---

## 3) Qiymət hesablanması (istədiyiniz qayda)

- Başlanğıc: **3.50 AZN**
- **3 km**-ə qədər əlavə km hesablanmır
- 3 km-dən sonra hər **1 km = 0.40 AZN**

Bunlar `.env` ilə dəyişir:
- `BASE_FARE_AZN=3.50`
- `FREE_KM=3`
- `PER_KM_AFTER_FREE_AZN=0.40`

Sürücü komissiyası:
- `DRIVER_COMMISSION_RATE=0.10` (10%)

Balans limit:
- `DRIVER_BALANCE_BLOCK_LIMIT=-15`
Balans <= -15 olarsa sürücü sifariş qəbul edə bilmir və səbəb ekranda görünür.

---

## 4) Xəritə + Naviqasiya

- Real xəritə üçün **OSRM** (OpenStreetMap routing) istifadə olunur:
  - Default: `https://router.project-osrm.org` (pulsuz, amma limit ola bilər)
  - Gələcəkdə öz OSRM serverinizi qurub `OSRM_BASE_URL` dəyişə bilərsiniz.

- Waze naviqasiya: sürücüyə link göndərilir (`waze.com/ul?...`).

---

## 5) Balans artırma (kart-to-kart / terminal / M10)

Ödəniş provayderlərinə birbaşa inteqrasiya etmək üçün onların rəsmi API-ları lazımdır.
Bu MVP-də belə işləyir:
1. Sürücü `/topup` → məbləğ yazır → üsul seçir → qəbz şəklini göndərir.
2. Admin paneldə **Topups** bölməsində qəbz görünür.
3. Admin **Approve** edəndə balans artır.

Bu, sizin tələb etdiyiniz “qəbzi sistemə yükləsin, admin baxıb balansına əlavə etsin” axınını tam verir.

---

## 6) Sürücü qeydiyyatı (tam axın)

Sürücü ilk dəfə `/start` edəndə qeydiyyat başlayır:
- Ad, soyad
- Telefon: **+994XXXXXXXXX**
- Avto: marka, model, nömrə
- Avto şəkli
- Sürücülük vəsiqəsi
- Şəxsiyyət vəsiqəsi (ön/arxa)
- Texniki pasport (ön/arxa)

Sonda status `pending` olur. Admin paneldən **Aktiv et**.

---

## 7) Qeyd

Bu paket “tam işlək MVP”dir. Bolt-un bütün dərin funksiyaları (dinamik tarif, heatmap, multi-dispatch, in-app payment, live tracking və s.) əlavə oluna bilər.
Növbəti addım kimi istəyirsinizsə:
- sürücünün canlı lokasiyasını avtomatik yeniləmək (interval)
- “planlaşdırılmış gediş”
- “prioritet/komfort” kateqoriya
- push bildirişləri
- driver rating

---

## Fayl strukturu

- `src/` — server + 3 bot
- `views/` — admin panel (EJS)
- `sql/schema.sql` — DB cədvəlləri

