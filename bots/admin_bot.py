import os
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000")
TOKEN = os.environ.get("ADMIN_BOT_TOKEN", "")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        f"PayTaksi Admin: panel -> {BASE_URL}/admin\nLogin: Ratik\nParol: 0123456789"
    )


def main():
    if not TOKEN:
        raise SystemExit("ADMIN_BOT_TOKEN is not set")
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.run_polling(stop_signals=None, close_loop=False)


if __name__ == "__main__":
    main()
