import os
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes

BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000")
TOKEN = os.environ.get("PASSENGER_BOT_TOKEN", "")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    url = f"{BASE_URL}/webapp/?from=passenger"
    kb = [[InlineKeyboardButton("🚕 PayTaksi aç", web_app=WebAppInfo(url=url))]]
    await update.message.reply_text(
        "PayTaksi: sifariş vermək üçün düyməyə basın.",
        reply_markup=InlineKeyboardMarkup(kb),
    )


def main():
    if not TOKEN:
        raise SystemExit("PASSENGER_BOT_TOKEN is not set")
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.run_polling(stop_signals=None, close_loop=False)


if __name__ == "__main__":
    main()
