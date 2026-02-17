# PayTaksi (Telegram MVP) — 3 bot + Admin panel (Render + GitHub)

Bu layihə **sıfırdan** PayTaksi üçün hazırlanmış MVP-dir:
- 3 ayrı Telegram bot:
  - **@PayTaksiPassenger_bot** (müştəri sifarişi)
  - **@PayTaksiDriver_bot** (sürücü paneli)
  - **@PayTaksiAdmin_bot** (admin bildiriş/təsdiqlər)
- Web **Admin panel**: sürücü təsdiqi, top-up (qəbz) təsdiqi, sifarişlər, xəritə (OSM/Leaflet)
- Qiymət qaydası:
  - Başlanğıc: **3.50 AZN**
  - 3 km-dən sonra: hər **1 km = 0.40 AZN**
- Komissiya: sürücü hər gediş üçün **10%** komissiya ödəyir (balansdan çıxılır)
- Balans limit: **balans <= -15 AZN** olarsa sifariş qəbul edilmir və səbəb göstərilir
- Xəritə: **OpenStreetMap (pulsuz)**
- Naviqasiya: **Waze link** (deep link)

> Qeyd: Bu MVP-də ödəniş növü “Nağd” kimi düşünülüb. Kart/M10/terminal inteqrasiyası **növbəti mərhələdə** real provayderlə (eManat, MilliÖn, M10 API və s.) əlavə olunur.

---

## 1) GitHub-a yüklə
1. Kompüterdə bu layihəni aç.
2. GitHub-da repo yarat: `paytaksi-mvp`
3. Push et.

---

## 2) Render-də Deploy (ən asan)
Render → New → **Web Service**
- Repo: `paytaksi-mvp`
- Build Command:
  - `npm install && npx prisma generate && npx prisma migrate deploy`
- Start Command:
  - `npm start`

### Render Postgres
Render → New → **PostgreSQL**
- DB yaradın, `Internal Database URL`-i götürün və Web Service Environment-ə yazın.

---

## 3) ENV (Render-də və local-da)
`.env.example` faylındakı kimi yazın:

- `DATABASE_URL`  (Render Postgres URL)
- `PASSENGER_BOT_TOKEN`
- `DRIVER_BOT_TOKEN`
- `ADMIN_BOT_TOKEN`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

---

## 4) BotFather — 3 bot yaratmaq (çox sadə)
Telegramda **@BotFather**:
1) `/newbot`
   - Name: `PayTaksi Sifariş Ver`
   - Username: `PayTaksiPassenger_bot` (boşdursa)
   - Token çıxacaq → `PASSENGER_BOT_TOKEN`

2) `/newbot`
   - Name: `PayTaksi Sürücü Ol`
   - Username: `PayTaksiDriver_bot`
   - Token → `DRIVER_BOT_TOKEN`

3) `/newbot`
   - Name: `PayTaksi Admin`
   - Username: `PayTaksiAdmin_bot`
   - Token → `ADMIN_BOT_TOKEN`

> İstəsəniz BotFather-da `/setcommands` ilə komandaları da verə bilərsiniz:
- Driver bot üçün:
  - start_trip - Gedişi başlat
  - finish_trip - Gedişi bitir

---

## 5) Admin Telegram istifadəçisi (vacib)
Admin botdan istifadə etmək üçün admin user DB-də olmalıdır.

Sadə yol:
1) Admin panelə gir: `https://YOUR-RENDER-URL/admin`
2) `.env`-də yazdığınız `ADMIN_EMAIL` / `ADMIN_PASSWORD` ilə login
3) Bu MVP-də Telegram admin user avtomatik əlavə olunmur.
   - Mənim təklifim: növbəti patch-də “Admin botda /link_admin” komandası ilə öz TG-nizi admin kimi bağlayaq.

Hazırda isə:
- Admin paneldən (web) hər şeyi idarə edə bilərsiniz.
- Admin bot bildirişləri yalnız DB-də `role=ADMIN` olan və `telegramId != 0` olan user-lara gedir.

---

## 6) İstifadə ssenarisi
### Müştəri botu
1) /start
2) “🚕 Taksi sifariş et”
3) 1-ci location: pickup
4) 2-ci location: drop
5) Sistem onlayn sürücülərə offer göndərir

### Sürücü botu
1) /start → ilk dəfə qeydiyyat wizard açılır
2) Admin təsdiqləyir → sürücü “🟢 Onlayn” olur
3) Sifariş gəlir → “✅ Qəbul et”
4) Gediş başlat: `/start_trip`
5) Bitir: `/finish_trip` → **iri/bold** məbləğ göstərilir

### Admin panel
- `/admin/drivers` → sürücü təsdiqlə/rədd
- `/admin/topups` → qəbzi təsdiqlə (balansa əlavə)
- `/admin/map` → sürücü location-ları + aktiv ride pickup-ları (OSM)

---

## 7) M10 / Terminal / Card-to-card (növbəti addım)
Bu MVP-də “qəbz yüklə → admin təsdiqlə” işləyir.
Real inteqrasiya üçün 3 yol var:
1) **Payment provider API** (ən doğru yol)
2) **Webhook** ilə avtomatik təsdiq (provayder icazə verirsə)
3) Sadə “manual” qalır (indiki kimi)

---

## Dəstək / Növbəti patch ideyaları
- Admin botda “/link_admin” (TG admin qoşmaq)
- Driver live-location avtomatik (müəyyən interval)
- Ride statusları: OFFERED, CANCEL, timeout
- Push notifikasiya, “nearby drivers” filter
- Tam Bolt stil UI (Telegram WebApp ilə)

