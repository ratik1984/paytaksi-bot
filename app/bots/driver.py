from __future__ import annotations

from decimal import Decimal
from datetime import datetime
from telegram import Update
from telegram.ext import (
    CommandHandler, MessageHandler, CallbackQueryHandler, ContextTypes, filters
)
from sqlalchemy.orm import Session

from ..models import Role, DriverProfile, DriverStatus, Ride, RideStatus, Topup, TopupMethod
from .common import get_or_create_user
from ..services.geocode import reverse_geocode

ALLOWED_COLORS = ["aq", "qara", "qirmizi", "boz", "mavi", "sari", "yashil"]
MIN_YEAR = 2010


def _driver_blocked(wallet_balance: Decimal) -> bool:
    # Balans -10 olanda sifariş ala bilməsin
    return wallet_balance <= Decimal("-10.00")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Salam! PayTaksi sürücü botu.\n"
        "Qeydiyyat üçün /register yaz.\n"
        "Balans: /balance\n"
        "Topup: /topup"
    )


async def register(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    context.user_data["reg_step"] = "car_year"
    await update.message.reply_text("Avtomobil buraxılış ilini yaz (minimum 2010):")


async def driver_text(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    step = context.user_data.get("reg_step")
    text = (update.message.text or "").strip()

    tg = update.effective_user.id
    u = get_or_create_user(db, tg, Role.driver, update.effective_user.full_name)

    dp = u.driver
    if dp is None:
        dp = DriverProfile(user_id=u.id, status=DriverStatus.pending)
        db.add(dp)
        db.commit()
        db.refresh(dp)

    if step == "car_year":
        try:
            year = int(text)
        except ValueError:
            await update.message.reply_text("İl rəqəm olmalıdır. Məs: 2015")
            return
        if year < MIN_YEAR:
            await update.message.reply_text("Minimum 2010 olmalıdır. Yenidən yaz.")
            return
        dp.car_year = year
        db.commit()
        context.user_data["reg_step"] = "car_color"
        await update.message.reply_text("Rəngi seç: " + "/".join(ALLOWED_COLORS))
        return

    if step == "car_color":
        color = text.lower()
        if color not in ALLOWED_COLORS:
            await update.message.reply_text("Rəng uyğunsuzdur. Seç: " + ", ".join(ALLOWED_COLORS))
            return
        dp.car_color = color
        db.commit()
        context.user_data["reg_step"] = "car_model"
        await update.message.reply_text("Avtomobil modeli yaz (məs: Toyota Prius):")
        return

    if step == "car_model":
        dp.car_model = text[:120]
        db.commit()
        context.user_data["reg_step"] = "plate"
        await update.message.reply_text("Dövlət nömrəsi yaz (məs: 10-AA-123):")
        return

    if step == "plate":
        dp.plate = text[:50]
        db.commit()
        context.user_data["reg_step"] = "id_front"
        await update.message.reply_text("İndi sənədləri yüklə.\n1) Şəxsiyyət vəsiqəsi ön üzünü foto göndər.")
        return


async def driver_photo(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    step = context.user_data.get("reg_step")
    if step not in {"id_front", "id_back", "dl_front", "dl_back", "tech_front", "tech_back"}:
        return

    tg = update.effective_user.id
    u = get_or_create_user(db, tg, Role.driver, update.effective_user.full_name)

    dp = u.driver
    if dp is None:
        dp = DriverProfile(user_id=u.id, status=DriverStatus.pending)
        db.add(dp)
        db.commit()
        db.refresh(dp)

    fid = update.message.photo[-1].file_id

    if step == "id_front":
        dp.id_front_file_id = fid
        context.user_data["reg_step"] = "id_back"
        await update.message.reply_text("Şəxsiyyət vəsiqəsi arxa üzünü göndər.")
    elif step == "id_back":
        dp.id_back_file_id = fid
        context.user_data["reg_step"] = "dl_front"
        await update.message.reply_text("Sürücülük vəsiqəsi ön üzünü göndər.")
    elif step == "dl_front":
        dp.dl_front_file_id = fid
        context.user_data["reg_step"] = "dl_back"
        await update.message.reply_text("Sürücülük vəsiqəsi arxa üzünü göndər.")
    elif step == "dl_back":
        dp.dl_back_file_id = fid
        context.user_data["reg_step"] = "tech_front"
        await update.message.reply_text("Texniki pasport ön üzünü göndər.")
    elif step == "tech_front":
        dp.tech_front_file_id = fid
        context.user_data["reg_step"] = "tech_back"
        await update.message.reply_text("Texniki pasport arxa üzünü göndər.")
    elif step == "tech_back":
        dp.tech_back_file_id = fid
        context.user_data["reg_step"] = None
        await update.message.reply_text(
            "Sənədlər tamamlandı ✅\n"
            "Admin təsdiqindən sonra sifariş ala biləcəksən."
        )

    db.commit()


async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    if not update.message.location:
        return

    tg = update.effective_user.id
    u = get_or_create_user(db, tg, Role.driver, update.effective_user.full_name)
    dp = u.driver
    if dp is None:
        dp = DriverProfile(user_id=u.id, status=DriverStatus.pending)
        db.add(dp)
        db.commit()
        db.refresh(dp)

    dp.last_lat = str(update.message.location.latitude)
    dp.last_lon = str(update.message.location.longitude)
    dp.last_loc_at = datetime.utcnow()
    db.commit()

    addr = ""
    try:
        addr = reverse_geocode(float(dp.last_lat), float(dp.last_lon))
    except Exception:
        addr = ""

    await update.message.reply_text("Lokasiya yeniləndi ✅" + (f"\n{addr[:120]}" if addr else ""))


async def balance(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    tg = update.effective_user.id
    u = get_or_create_user(db, tg, Role.driver, update.effective_user.full_name)
    bal = Decimal(str(u.wallet.balance))
    msg = f"Balans: {bal} AZN"
    if _driver_blocked(bal):
        msg += "\n⚠️ Balans ≤ -10 olduğu üçün yeni sifariş qəbul edə bilmirsən."
    await update.message.reply_text(msg)


async def topup(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Balans artırma:\n"
        "Kart2Kart: /topup_card 10\n"
        "M10: /topup_m10 10\n"
        "Top-up admin təsdiqi ilə balansa düşür."
    )


async def _topup_create(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session, method: TopupMethod):
    tg = update.effective_user.id
    u = get_or_create_user(db, tg, Role.driver, update.effective_user.full_name)

    try:
        amount = Decimal(context.args[0])
    except Exception:
        await update.message.reply_text("Məbləği düzgün yaz. Məs: /topup_card 10")
        return

    if amount <= 0:
        await update.message.reply_text("Məbləğ müsbət olmalıdır.")
        return

    t = Topup(user_id=u.id, method=method, amount=amount, note="")
    db.add(t)
    db.commit()
    db.refresh(t)
    await update.message.reply_text(
        f"Top-up sorğusu yaradıldı (№{t.id}) — {amount} AZN ({method.value}). Admin təsdiqini gözlə."
    )


async def topup_card(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    await _topup_create(update, context, db, TopupMethod.card2card)


async def topup_m10(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    await _topup_create(update, context, db, TopupMethod.m10)


async def driver_router(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    # Accept/decline ride (callback)
    if not update.callback_query:
        return

    cq = update.callback_query
    data = cq.data or ""
    if not data.startswith("ride|"):
        return

    await cq.answer()
    _, action, ride_id_s = data.split("|", 2)
    ride_id = int(ride_id_s)

    tg = cq.from_user.id
    u = get_or_create_user(db, tg, Role.driver, cq.from_user.full_name)

    if action == "accept":
        bal = Decimal(str(u.wallet.balance))
        if _driver_blocked(bal):
            await cq.answer("Balans ≤ -10, qəbul edilmir.", show_alert=True)
            return
        ride = db.query(Ride).filter_by(id=ride_id).one_or_none()
        if not ride or ride.status not in {RideStatus.offered, RideStatus.new}:
            await cq.edit_message_text("Sifariş artıq mövcud deyil.")
            return
        ride.status = RideStatus.accepted
        ride.driver_user_id = u.id
        db.commit()
        await cq.edit_message_text("✅ Sifarişi qəbul etdin.")
        return

    if action == "decline":
        ride = db.query(Ride).filter_by(id=ride_id).one_or_none()
        if ride and ride.status == RideStatus.offered and ride.driver_user_id == u.id:
            ride.status = RideStatus.new
            ride.driver_user_id = None
            db.commit()
        await cq.edit_message_text("❌ Təklif rədd edildi.")


def build_handlers():
    return [
        CommandHandler("start", start),
        CommandHandler("register", register),
        CommandHandler("balance", lambda u, c: None),  # db-bound in main
        CommandHandler("topup", topup),
        CommandHandler("topup_card", lambda u, c: None),  # db-bound in main
        CommandHandler("topup_m10", lambda u, c: None),    # db-bound in main
        MessageHandler(filters.LOCATION, lambda u, c: None),  # db-bound in main
        MessageHandler(filters.PHOTO, lambda u, c: None),     # db-bound in main
        MessageHandler(filters.TEXT & ~filters.COMMAND, lambda u, c: None),  # db-bound in main
        CallbackQueryHandler(lambda u, c: None),  # db-bound in main
    ]
