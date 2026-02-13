import os
import asyncio
import threading
from typing import Optional, List

from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
from telegram import InlineKeyboardButton, InlineKeyboardMarkup

def _make_start_handler(webapp_url: str, title: str, button_text: str):
    async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not update.message:
            return

        # 1) Inline button (best UX: appears under the message)
        inline = InlineKeyboardMarkup([
            [InlineKeyboardButton(button_text, web_app={"url": webapp_url})]
        ])

        # 2) Also provide a reply keyboard WebApp button (works well on mobile)
        reply_kb = {
            "keyboard": [[{"text": button_text, "web_app": {"url": webapp_url}}]],
            "resize_keyboard": True
        }

        # IMPORTANT: do NOT print the URL in the message, so users don't click a normal link.
        await update.message.reply_text(
            f"{title} hazırdır ✅\n\nAşağıdakı düyməyə bas və tətbiq açılacaq:",
            reply_markup=inline
        )

        # Send reply keyboard too (separate message) so it stays visible.
        await update.message.reply_text(
            "Düymə aşağıda da görünür 👇",
            reply_markup=reply_kb
        )
    return start

class BotGroup:
    def __init__(self, apps: List):
        self.apps = apps
        self.thread: Optional[threading.Thread] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None

    async def _run(self):
        for app in self.apps:
            await app.initialize()
            await app.start()
            await app.updater.start_polling(drop_pending_updates=True)
        while True:
            await asyncio.sleep(3600)

    def start_in_thread(self):
        def runner():
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            self.loop.run_until_complete(self._run())
        self.thread = threading.Thread(target=runner, daemon=True)
        self.thread.start()

def build_bot_apps(base_url: str):
    passenger = os.getenv("PASSENGER_BOT_TOKEN", "").strip()
    driver = os.getenv("DRIVER_BOT_TOKEN", "").strip()
    admin = os.getenv("ADMIN_BOT_TOKEN", "").strip()

    apps = []

    if passenger:
        app = ApplicationBuilder().token(passenger).build()
        url = f"{base_url}/webapp/?from=passenger"
        app.add_handler(CommandHandler("start", _make_start_handler(url, "PayTaksi Sərnişin", "🚕 Taksi sifariş ver")))
        apps.append(app)

    if driver:
        app = ApplicationBuilder().token(driver).build()
        url = f"{base_url}/webapp/?from=driver"
        app.add_handler(CommandHandler("start", _make_start_handler(url, "PayTaksi Sürücü", "🚗 Sürücü paneli")))
        apps.append(app)

    if admin:
        app = ApplicationBuilder().token(admin).build()
        panel = f"{base_url}/admin"
        async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
            if update.message:
                await update.message.reply_text(f"Admin panel linki:\n{panel}")
        app.add_handler(CommandHandler("start", start))
        apps.append(app)

    return apps
