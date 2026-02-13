# PayTaksi (Telegram Mini App + 3 Bot + Admin Panel) — işlək prototip

Bu layihədə 1 backend (FastAPI), 1 Telegram WebApp (mini app) və 3 ayrı bot var:
- Passenger bot
- Driver bot
- Admin bot

## Qaydalar
- Komissiya: **10%**
- Başlanğıc qiymət: **3.50 AZN**
- 3 km-dən sonra: **0.40 AZN / km**
- Sürücü balansı **<= -10 AZN** olduqda: sifariş qəbul edə bilmir
- Sürücü qeydiyyatı:
  - Avto ili: minimum **2010**
  - Rənglər: **ağ, qara, qırmızı, boz, mavi, sarı, yaşıl**
  - Sənədlər (ön+arxa): şəxsiyyət vəsiqəsi, sürücülük vəsiqəsi, texniki pasport

## 1) Botların yaradılması (BotFather)
3 bot yarat:
- PayTaksiPassengerBot -> token -> `PASSENGER_BOT_TOKEN`
- PayTaksiDriverBot -> token -> `DRIVER_BOT_TOKEN`
- PayTaksiAdminBot -> token -> `ADMIN_BOT_TOKEN`

> Driver bot üçün inline buttons istifadə olunur (accept/decline). BotFather-də lazım olsa: `/setinline` -> Enable.

## 2) Render deploy (Postgres)
Bu repo/zip `render.yaml` ilə hazırdır.

### Addım-addım
1. Render -> **New** -> **Blueprint** -> GitHub repo seç.
2. Render avtomatik:
   - 1 Web Service (API)
   - 3 Worker (3 bot)
   - 1 Postgres DB yaradacaq.
3. **paytaksi-api** service-də `Environment` bölməsində bunları doldur:
   - `PUBLIC_BASE_URL` = https://<sənin-paytaksi-api>.onrender.com
   - `API_BASE` = eyni URL (worker-lar üçün)
   - `SESSION_SECRET` = uzun random string
   - `PASSENGER_BOT_TOKEN`, `DRIVER_BOT_TOKEN`, `ADMIN_BOT_TOKEN`
   - `DATABASE_URL` = Render Postgres-dən verilən bağlantı URL-i

> Render DB yaradandan sonra `DATABASE_URL` dəyərini Postgres panelindən götür.

## 3) Telegram Mini App kimi açılması
Passenger bot /start mesajında “PayTaksi aç” düyməsi WebApp açır.

Əlavə olaraq BotFather:
- Passenger bot üçün `/setdomain` -> **PUBLIC_BASE_URL** domenini əlavə et.

## 4) İstifadə
### Driver
1. Driver bot: `/start` -> WebApp aç.
2. “Qeydiyyat” (il, rəng) -> sənədləri yüklə.
3. Driver bot-da: `/location` -> location göndər.
4. WebApp-də “Online ol”.
5. Sifariş gəldikdə Accept/Decline.
6. Gediş bitəndə: `/complete <ride_id>`.

### Passenger
1. Passenger bot: `/start` -> WebApp aç.
2. Location icazəsi ver.
3. Gedəcəyin yeri yaz (autocomplete çıxacaq).
4. “Sifariş et”.

### Admin
- Admin panel: `.../admin`
- Login: **Ratik**
- Parol: **0123456789**
- Sürücü təsdiqlə/reject.
- TopUp approve/reject.

## Qeyd
Bu MVP prototipdir:
- Qiymət hesablaması haversine məsafə ilə edilir (real naviqasiya yolu deyil).
- Kart->kart və m10 real ödəniş inteqrasiyası üçün rəsmi API/rekvizitlər lazımdır; burada “topup request” admin təsdiqi ilə işləyir.
