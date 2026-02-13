import os
import asyncio
import threading
from typing import Optional, List

from telegram import Update, WebAppInfo
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

def _make_start_handler(webapp_url: str, title: str):
    async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if update.message:
            await update.message.reply_text(
                f"{title} hazırdır. Aşağıdakı düymə ilə aç:\n{webapp_url}",
                reply_markup={
                    "keyboard": [[{"text": "Aç (WebApp)", "web_app": {"url": webapp_url}}]],
                    "resize_keyboard": True
                }
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
        # keep running
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
        app.add_handler(CommandHandler("start", _make_start_handler(url, "PayTaksi Sərnişin")))
        apps.append(app)

    if driver:
        app = ApplicationBuilder().token(driver).build()
        url = f"{base_url}/webapp/?from=driver"
        app.add_handler(CommandHandler("start", _make_start_handler(url, "PayTaksi Sürücü")))
        apps.append(app)

    if admin:
        app = ApplicationBuilder().token(admin).build()
        panel = f"{base_url}/admin"
        async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
            if update.message:
                await update.message.reply_text(f"Admin panel: {panel}")
        app.add_handler(CommandHandler("start", start))
        apps.append(app)

    return apps
