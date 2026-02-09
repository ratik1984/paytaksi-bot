# PayTaksi (Telegram Mini App + Bot + Admin Panel) — Full Starter

Bu paket: **1 bot + 3 WebApp** (Sərnişin / Sürücü / Admin) + **canlı xəritə** + **sifariş sistemi** + **admin nəzarəti**.

## Nələr var
- Telegram bot:
  - `/start` menyusu: Sərnişin, Sürücü, Admin
  - WebApp linkləri (mobil tətbiq kimi açılır)
- Sərnişin WebApp:
  - Avtomatik yer (GPS) + xəritə
  - Ünvan axtarışı (Nominatim) — yazdıqca nəticələr
  - Sifariş yarat, tarixçə, reytinq ver
- Sürücü WebApp:
  - Qeydiyyat (telefon, avtomobil məlumatları, sənədlər foto) **məcburi**
  - Admin təsdiqi (approve/reject)
  - Online/Offline
  - Yeni sifariş gələndə **“zəng kimi” ekran** (WebApp daxilində full-screen + səs)
  - Canlı rider/driver markerləri, sifarişi qəbul et, bitir
- Admin Panel:
  - Pending sürücülər, approve/reject
  - İstifadəçi siyahısı, ride-lər, statistika
  - Sistem logları (sadə)

## Qısa quraşdırma (lokal)
1) `npm i`
2) `.env.example` -> `.env`
3) Postgres hazırlayın və `DATABASE_URL` yazın
4) `npm run migrate`
5) `npm run dev`

## Render-də deploy
- Repo GitHub-a push edin
- Render: New > Blueprint > bu repo seçin (`render.yaml` var)
- Render Postgres yaradın və `DATABASE_URL` env verin
- `PUBLIC_BASE_URL` render domeniniz olmalıdır (məs: https://paytaksi-bot.onrender.com)

## Telegram BotFather
- Bot token alın (`BOT_TOKEN`)
- WebApp domeniniz `PUBLIC_BASE_URL` olmalıdır
- Webhook:
  - Deploy olandan sonra server özü `PUBLIC_BASE_URL/webhook/<WEBHOOK_SECRET>` üçün webhook qura bilər.
  - Alternativ: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<PUBLIC_BASE_URL>/webhook/<WEBHOOK_SECRET>`

## Vacib qeydlər
- Telegram “telefon zəngi” kimi sistem call UI vermir. Burda **WebApp daxilində** full-screen call ekran + səs edilir (ən yaxın UX).
- Canlı hərəkət: Driver location `watchPosition` ilə serverə göndərilir və rider ekranında marker hərəkət edir.

