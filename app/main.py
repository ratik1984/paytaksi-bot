from __future__ import annotations
import asyncio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.sessions import SessionMiddleware

from telegram import Update
from telegram.ext import Application

from .config import (
    PAYTAKSI_PASSENGER_BOT_TOKEN,
    PAYTAKSI_DRIVER_BOT_TOKEN,
    PAYTAKSI_ADMIN_BOT_TOKEN,
    BASE_URL,
    SECRET_KEY
)
from .db import engine, SessionLocal
from .models import Base, Setting
from .web.admin import router as admin_router

from .bots import passenger as passenger_bot
from .bots import driver as driver_bot
from .bots import admin_bot as admin_bot_mod

# ---- FastAPI ----
app = FastAPI(title="PayTaksi")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, https_only=False)
app.include_router(admin_router)

# ---- DB init ----
Base.metadata.create_all(bind=engine)

def _seed_settings():
    db = SessionLocal()
    try:
        def put(k,v):
            s = db.query(Setting).filter_by(key=k).one_or_none()
            if not s:
                db.add(Setting(key=k, value=v))
        put("commission_rate","0.10")
        put("base_fare","3.50")
        put("included_km","3.0")
        put("per_km_after","0.40")
        db.commit()
    finally:
        db.close()

_seed_settings()

# ---- Telegram Applications (3 bots) ----
passenger_app: Application | None = None
driver_app: Application | None = None
admin_app: Application | None = None

def _db_session():
    return SessionLocal()

def _bind_passenger_handlers(a: Application):
    for h in passenger_bot.build_handlers():
        a.add_handler(h)

def _bind_driver_handlers(a: Application):
    for h in driver_bot.build_handlers():
        a.add_handler(h)

def _bind_admin_handlers(a: Application):
    for h in admin_bot_mod.build_handlers():
        a.add_handler(h)

async def _set_webhook(token: str, path: str):
    if not token:
        return
    url = f"{BASE_URL}{path}"
    from telegram import Bot
    bot = Bot(token)
    await bot.set_webhook(url=url, drop_pending_updates=True)

@app.on_event("startup")
async def startup():
    global passenger_app, driver_app, admin_app
    # passenger
    if PAYTAKSI_PASSENGER_BOT_TOKEN:
        passenger_app = Application.builder().token(PAYTAKSI_PASSENGER_BOT_TOKEN).build()
        _bind_passenger_handlers(passenger_app)
        await passenger_app.initialize()
        await _set_webhook(PAYTAKSI_PASSENGER_BOT_TOKEN, "/webhook/passenger")

    # driver
    if PAYTAKSI_DRIVER_BOT_TOKEN:
        driver_app = Application.builder().token(PAYTAKSI_DRIVER_BOT_TOKEN).build()
        _bind_driver_handlers(driver_app)
        await driver_app.initialize()
        await _set_webhook(PAYTAKSI_DRIVER_BOT_TOKEN, "/webhook/driver")

    # admin
    if PAYTAKSI_ADMIN_BOT_TOKEN:
        admin_app = Application.builder().token(PAYTAKSI_ADMIN_BOT_TOKEN).build()
        _bind_admin_handlers(admin_app)
        await admin_app.initialize()
        await _set_webhook(PAYTAKSI_ADMIN_BOT_TOKEN, "/webhook/admin")

@app.get("/")
def root():
    return {"ok": True, "service": "PayTaksi"}

async def _process_update(app_obj: Application, upd_json: dict, kind: str):
    db = _db_session()
    try:
        upd = Update.de_json(upd_json, app_obj.bot)
        # route custom actions needing db
        if kind == "passenger":
            await passenger_bot.passenger_router(upd, app_obj.context_types.context.from_update(upd, app_obj), db)  # safe no-op if not
        elif kind == "driver":
            await driver_bot.driver_router(upd, app_obj.context_types.context.from_update(upd, app_obj), db)
        elif kind == "admin":
            await admin_bot_mod.admin_router(upd, app_obj.context_types.context.from_update(upd, app_obj), db)

        # patch handlers requiring db (we used placeholders, so intercept commands)
        # We run the default dispatcher first, then do db-bound commands manually.
        await app_obj.process_update(upd)

        # manual db-bound commands by inspecting update:
        if kind == "driver" and upd.message and upd.message.text:
            txt = upd.message.text.strip()
            if txt.startswith("/topup_card"):
                ctx = app_obj.context_types.context.from_update(upd, app_obj)
                ctx.args = txt.split()[1:]
                await driver_bot.topup_card(upd, ctx, db)
            elif txt.startswith("/topup_m10"):
                ctx = app_obj.context_types.context.from_update(upd, app_obj)
                ctx.args = txt.split()[1:]
                await driver_bot.topup_m10(upd, ctx, db)
            elif txt.startswith("/balance"):
                ctx = app_obj.context_types.context.from_update(upd, app_obj)
                await driver_bot.balance(upd, ctx, db)
            elif upd.message.location:
                ctx = app_obj.context_types.context.from_update(upd, app_obj)
                await driver_bot.handle_location(upd, ctx, db)
            elif upd.message.photo:
                ctx = app_obj.context_types.context.from_update(upd, app_obj)
                await driver_bot.driver_photo(upd, ctx, db)
            elif not txt.startswith("/"):
                ctx = app_obj.context_types.context.from_update(upd, app_obj)
                await driver_bot.driver_text(upd, ctx, db)

        if kind == "admin" and upd.message and upd.message.text:
            txt = upd.message.text.strip()
            ctx = app_obj.context_types.context.from_update(upd, app_obj)
            if txt.startswith("/pending_drivers"):
                await admin_bot_mod.pending_drivers(upd, ctx, db)
            elif txt.startswith("/pending_topups"):
                await admin_bot_mod.pending_topups(upd, ctx, db)

        if kind == "passenger" and upd.callback_query and upd.callback_query.data and upd.callback_query.data.startswith("dest|"):
            ctx = app_obj.context_types.context.from_update(upd, app_obj)
            await passenger_bot.choose_dest(upd, ctx, db)

    finally:
        db.close()

@app.post("/webhook/passenger")
async def webhook_passenger(request: Request):
    if not passenger_app:
        return JSONResponse({"ok": False, "error": "passenger bot not configured"}, status_code=400)
    upd_json = await request.json()
    await _process_update(passenger_app, upd_json, "passenger")
    return {"ok": True}

@app.post("/webhook/driver")
async def webhook_driver(request: Request):
    if not driver_app:
        return JSONResponse({"ok": False, "error": "driver bot not configured"}, status_code=400)
    upd_json = await request.json()
    await _process_update(driver_app, upd_json, "driver")
    return {"ok": True}

@app.post("/webhook/admin")
async def webhook_admin(request: Request):
    if not admin_app:
        return JSONResponse({"ok": False, "error": "admin bot not configured"}, status_code=400)
    upd_json = await request.json()
    await _process_update(admin_app, upd_json, "admin")
    return {"ok": True}
