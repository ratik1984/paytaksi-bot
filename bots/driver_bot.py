import os
import httpx
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, ReplyKeyboardMarkup, KeyboardButton
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, ContextTypes, filters

BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000")
API_BASE = os.environ.get("API_BASE", BASE_URL)
TOKEN = os.environ.get("DRIVER_BOT_TOKEN", "")


async def ask_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Ask driver to share location (for matching)."""
    if not update.message:
        return
    kb = ReplyKeyboardMarkup(
        [[KeyboardButton("📍 Location göndər", request_location=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
    )
    await update.message.reply_text(
        "📍 Location göndərin (Telegram düyməsini basın) ki yaxın sifarişlər gəlsin.",
        reply_markup=kb,
    )


async def on_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.location:
        return
    tg_id = update.message.from_user.id
    lat = update.message.location.latitude
    lng = update.message.location.longitude
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(f"{API_BASE}/api/driver/update_location", data={"tg_id": tg_id, "lat": lat, "lng": lng})
    await update.message.reply_text("✅ Location yeniləndi. İndi online ola bilərsiniz.")


async def complete_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Mark ride completed: /complete <ride_id>"""
    if not update.message:
        return
    if not context.args:
        await update.message.reply_text("İstifadə: /complete <ride_id>")
        return
    try:
        ride_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("Ride ID yanlışdır")
        return
    tg_id = update.message.from_user.id
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{API_BASE}/api/driver/complete", data={"ride_id": ride_id, "tg_id": tg_id})
    if r.status_code == 200:
        js = r.json()
        await update.message.reply_text(f"✅ Tamamlandı. Yeni balans: {js.get('balance','?')} AZN")
    else:
        await update.message.reply_text("⚠️ Server xətası")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    url = f"{BASE_URL}/webapp/?from=driver"
    kb = [[InlineKeyboardButton("🚗 PayTaksi Sürücü Paneli", web_app=WebAppInfo(url=url))]]
    await update.message.reply_text(
        "PayTaksi Sürücü: qeydiyyat, balans və online olmaq üçün düyməyə basın.",
        reply_markup=InlineKeyboardMarkup(kb),
    )


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data or ""
    if ":" not in data:
        return
    action, rid = data.split(":", 1)
    try:
        ride_id = int(rid)
    except ValueError:
        return
    tg_id = query.from_user.id

    endpoint = None
    if action == "accept":
        endpoint = "/api/driver/accept_offer"
    elif action == "decline":
        endpoint = "/api/driver/decline_offer"

    if not endpoint:
        return

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{API_BASE}{endpoint}", data={"ride_id": ride_id, "tg_id": tg_id})

    if r.status_code == 200:
        js = r.json()
        if js.get("ok"):
            await query.edit_message_text(f"✅ Ride #{ride_id}: qəbul etdiniz")
        else:
            await query.edit_message_text(f"⚠️ Ride #{ride_id}: {js.get('reason','mümkün deyil')}")
    else:
        await query.edit_message_text("⚠️ Server xətası")


def main():
    if not TOKEN:
        raise SystemExit("DRIVER_BOT_TOKEN is not set")
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("location", ask_location))
    app.add_handler(CommandHandler("complete", complete_cmd))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(filters.LOCATION, on_location))
    app.run_polling(close_loop=False)


if __name__ == "__main__":
    main()
