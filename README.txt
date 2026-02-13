PayTaksi Minimal Telegram WebApp (initData oxuyan)

Quraşdırma:
1) Bu qovluğu serverində public yerə at (məs: /webapp/).
2) BotFather -> Menu Button / Web App URL:
   https://paytaksi-api.onrender.com/webapp/?from=passenger
3) Telegram-da mavi WebApp düyməsi ilə aç.
   Düzdürsə, yuxarıda TG ID unknown yerinə real ID görünəcək.

Qeyd:
- Bu variant initDataUnsafe istifadə edir (UI üçün 100% işləyir).
- İstehsal (real pul/balans) üçün backend verify (HMAC) əlavə etmək məsləhətdir.
