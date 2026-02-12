# PayTaksi (Telegram Taxi MVP) — Passenger Bot + Driver Bot + Admin Bot + Web Admin Panel

Bu paket **işlək MVP**-dir: 3 ayrı Telegram botu (sərnişin/sürücü/admin) + geniş Web Admin Panel (FastAPI).
Render-də 1 web service kimi işləyir (webhook).

## Nələr var?
- **Sərnişin botu**
  - /start → lokasiya istəyi (avtomatik götürmək üçün “Location” paylaşır)
  - Gediləcək yeri yazanda **alternativ yaxın nəticələr** (OpenStreetMap Nominatim)
  - Sifariş yaratma, sürücüyə ötürmə, status izləmə
- **Sürücü botu**
  - Qeydiyyat (2010+ il şərti, rəng seçimi)
  - Sənəd yükləmə: Ş/V (2 üz), Sürücülük vəsiqəsi (2 üz), Texniki pasport (2 üz)
  - Balans görmə
  - Balans artırma sorğusu: **Kart2Kart** və **M10** (admin təsdiqi ilə)
  - Balans **≤ -10** olduqda yeni sifariş qəbul edə bilmir
- **Admin botu**
  - Qısa əmrlər: pending sürücülər, pending topuplar, approve/reject
- **Web Admin Panel**
  - Sürücülər (approve/reject), sənədlərə baxış (file_id)
  - Sifarişlər, statuslar, komissiya və hesablaşma
  - Top-up sorğuları: təsdiq/imtina
  - Ayarlar: komissiya (default 10%), tarif (3.50 AZN + 3km-dən sonra 0.40/km)

## Tarif (default)
- Başlanğıc: **3.50 AZN** (ilk **3km** daxil)
- **3km**-dən sonra hər **1km = 0.40 AZN**
- Komissiya: **10%** (admin paneldən dəyişir)

> Qeyd: məsafə hesabı MVP-də **haversine (düz xətt)** ilədir. İstəsən OSRM/Google ilə yol məsafəsinə keçirə bilərik.

---

## Tələblər (Render üçün)
- Render Web Service (Python)
- Render Postgres (tövsiyə olunur)

## Lokal işə salmaq
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # env-ləri doldur
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Telegram bot tokenləri
BotFather-dan 3 bot tokeni al:
- PAYTAKSI_PASSENGER_BOT_TOKEN
- PAYTAKSI_DRIVER_BOT_TOKEN
- PAYTAKSI_ADMIN_BOT_TOKEN

## Render-də quraşdırma (addım-addım)
1) **GitHub-a push et**
   - Bu layihəni GitHub repo-a yüklə.
2) **Render → New → Web Service**
   - Repo seç
   - Runtime: Python
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
3) **Render → New → PostgreSQL**
   - DB yarat, `Internal Database URL`-i götür.
4) Web Service → **Environment**
   - `DATABASE_URL` = Render Postgres URL
   - `BASE_URL` = Sənin render domenin (məs: https://paytaksi.onrender.com)
   - `PAYTAKSI_PASSENGER_BOT_TOKEN` = ...
   - `PAYTAKSI_DRIVER_BOT_TOKEN` = ...
   - `PAYTAKSI_ADMIN_BOT_TOKEN` = ...
   - `ADMIN_USERNAME` = Ratik
   - `ADMIN_PASSWORD` = 0123456789  (tövsiyə: dəyiş!)
   - `SECRET_KEY` = istənilən uzun random (məs: 32+ simvol)
5) Deploy bitəndə servis start olanda webhook-lar avtomatik set olunur:
   - /webhook/passenger
   - /webhook/driver
   - /webhook/admin

## Web Admin Panel
- URL: `https://<BASE_URL>/admin`
- Login: env-dən (default: Ratik / 0123456789)

---

## Təhlükəsizlik qeydi
Default admin parolu açıqdır — **deploy edəndən sonra dəyişmək vacibdir**.

---

## Fayl strukturu
- `app/main.py` FastAPI app + webhook route-lar
- `app/bots/*` botların handler-ləri
- `app/web/*` admin panel (Jinja2)
- `app/models.py` SQLAlchemy modellər
- `app/services/*` qiymət, geocode, assign, məsafə

