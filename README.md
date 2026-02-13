# PayTaksi (Telegram Mini App) — MVP

Bu paket **3 ayrı Telegram botu** ilə işləyən bir MVP-dir:
- **Sərnişin botu** → Sərnişin Mini App
- **Sürücü botu** → Sürücü Mini App (qeydiyyat + balans + sifariş qəbul etmə)
- **Admin botu** → Admin panel (web) + Basic Auth

Texnologiya: **Node.js + Express + PostgreSQL + Telegram Mini Apps (WebApp)**.  
Render üçün hazırdır (`render.yaml` var). citeturn0search0turn0search1turn0search2

---

## 1) Telegram-da botları sıfırdan yaratmaq (3 bot)

1. Telegram-da **@BotFather** aç.
2. ` /newbot ` → ad ver (məs: `PayTaksi Passenger`) → username ver (məs: `PayTaksiPassengerBot`)
3. Tokeni saxla.
4. Eyni qayda ilə 2 bot daha yarat:
   - `PayTaksiDriverBot`
   - `PayTaksiAdminBot`

> Hər botun ayrıca tokeni olacaq.

---

## 2) GitHub-a yüklə

Bu qovluğu repo kimi GitHub-a push et.

---

## 3) Render-də qurulum

Render Docs: Node/Express deploy. citeturn0search1turn0search5

### A) DB yarat
- Render → **New** → **PostgreSQL**
- Ad: `paytaksi-db` (render.yaml-da da var)
- Yaranan **DATABASE_URL**-i götür.

### B) Web Service yarat
- Render → **New** → **Web Service**
- GitHub repo seç
- Build: `npm install`
- Start: `npm start`

### C) Environment variables (Render → Service → Environment)
ZƏRURİ:
- `DATABASE_URL` = Render Postgres connection string
- `APP_BASE_URL` = Render URL (məs: `https://paytaksi-telegram.onrender.com`)
- `WEBHOOK_SECRET` = uzun gizli söz (məs: `a8f1...`)

Bot tokenləri:
- `PASSENGER_BOT_TOKEN`
- `DRIVER_BOT_TOKEN`
- `ADMIN_BOT_TOKEN`

Admin panel basic auth:
- `ADMIN_WEB_USER` = `Ratik`
- `ADMIN_WEB_PASS` = `0123456789`

---

## 4) Webhook-ları qoşmaq

Telegram webhook docs. citeturn0search2turn0search13

Hər bot üçün setWebhook çağır:

### Passenger bot
```
https://api.telegram.org/bot<PASSENGER_TOKEN>/setWebhook?url=<APP_BASE_URL>/webhook/<WEBHOOK_SECRET>/passenger
```

### Driver bot
```
https://api.telegram.org/bot<DRIVER_TOKEN>/setWebhook?url=<APP_BASE_URL>/webhook/<WEBHOOK_SECRET>/driver
```

### Admin bot
```
https://api.telegram.org/bot<ADMIN_TOKEN>/setWebhook?url=<APP_BASE_URL>/webhook/<WEBHOOK_SECRET>/admin
```

---

## 5) Mini App “tam app kimi” görünməsi

Bu paket Telegram Mini Apps istifadə edir: bot `Start` edəndə **web_app button** ilə panel açılır. citeturn0search0

URL-lər:
- Sərnişin: `/app/passenger/`
- Sürücü: `/app/driver/`
- Admin: `/app/admin/`

---

## Biznes qaydaları (sənin istədiyin kimi)

- Komissiya: **10%**
- Sürücü balansı **-10** və ya aşağıdırsa → sifariş ala bilmir
- Başlanğıc qiymət: **3.50 AZN**
- **3 km**-dən sonra hər 1 km: **0.40 AZN**
- Sürücü qeydiyyat: minimum **2010** buraxılış ili
- Rənglər: **ağ, qara, qırmızı, boz, mavi, sarı, yaşıl**
- Sənədlər upload: şəxsiyyət (ön/arxa), sürücülük (ön/arxa), texniki pasport (ön/arxa)

---

## Balans artırma (kart-to-kart və m10)

Bu MVP-də **inteqrasiya API** yoxdur — *manual təsdiq* var:
- Sürücü paneldən topup sorğusu göndərir (məbləğ + metod + reference)
- Admin paneldən **Approve** etdikdə balans artır

M10 haqqında rəsmi imkanlar/inteqrasiya üçün m10 biznes səhifəsinə baxmaq olar. citeturn0search18turn0search7

---

## Lokal işə salmaq

1) Postgres hazırla və `DATABASE_URL` set et  
2) Qovluqda:
```bash
npm install
npm run db:seed
npm run dev
```

---

## Qeyd

- Upload faylları Render-də diskdə saxlanır (ephemeral). Real production üçün S3 kimi storage lazımdır.
- Naviqasiya/distance real yol məsafəsi deyil, **haversine** (düz xətt) hesablanır — MVP üçün.
