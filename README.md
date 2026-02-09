# PayTaksi Telegram Bot

Bu paket **minimal işlək skeleton**-dur: **Sərnişin + Sürücü + Admin**.

## 1) Quraşdırma

```bash
npm install
cp .env.example .env
```

`.env` içində:
- `BOT_TOKEN` → BotFather token
- `ADMIN_IDS` → admin Telegram ID-lər (vergüllə)

## 2) İşə sal

```bash
npm start
```

## 3) Botda əsas komandalar
- `/start` → menyu
- `/id` → sənin Telegram ID-ni göstərir

## Qısa axın
- Sürücü: **Onlayn ol** → sistemə daxil olur və sifariş qəbul edə bilir.
- Sərnişin: **Taksi sifariş et** → pickup + dropoff → sistem ən yaxın (sıra ilə) onlayn sürücülərə offer göndərir.
- Sürücü: offer-i **Qəbul et** → sərnişinə sürücü məlumatı gedir.

> Qeyd: Bu skeleton sadədir (demo). Real layihədə DB (MySQL) + xəritə/geocode + ETA + zonalar əlavə olunur.
