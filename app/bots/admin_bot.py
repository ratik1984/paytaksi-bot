from __future__ import annotations
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import CommandHandler, ContextTypes, CallbackQueryHandler
from sqlalchemy.orm import Session
from ..models import DriverProfile, DriverStatus, User, Role, Topup, TopupStatus
from decimal import Decimal
from datetime import datetime

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Admin bot. Əmrlər:
"
        "/pending_drivers
"
        "/pending_topups"
    )

async def pending_drivers(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    q = (
        db.query(User, DriverProfile)
        .join(DriverProfile, DriverProfile.user_id == User.id)
        .filter(User.role == Role.driver, DriverProfile.status == DriverStatus.pending)
        .all()
    )
    if not q:
        await update.message.reply_text("Pending sürücü yoxdur.")
        return
    for u, dp in q[:20]:
        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("Approve", callback_data=f"drv|approve|{dp.id}"),
            InlineKeyboardButton("Reject", callback_data=f"drv|reject|{dp.id}"),
        ]])
        await update.message.reply_text(
            f"Sürücü: {u.name} (tg:{u.telegram_id})
"
            f"Car: {dp.car_year} {dp.car_color} {dp.car_model} / {dp.plate}
"
            f"Docs: ID({bool(dp.id_front_file_id and dp.id_back_file_id)}), "
            f"DL({bool(dp.dl_front_file_id and dp.dl_back_file_id)}), "
            f"Tech({bool(dp.tech_front_file_id and dp.tech_back_file_id)})",
            reply_markup=kb
        )

async def pending_topups(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    topups = db.query(Topup).filter(Topup.status == TopupStatus.pending).order_by(Topup.id.desc()).limit(20).all()
    if not topups:
        await update.message.reply_text("Pending top-up yoxdur.")
        return
    for t in topups:
        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("Approve", callback_data=f"top|approve|{t.id}"),
            InlineKeyboardButton("Reject", callback_data=f"top|reject|{t.id}"),
        ]])
        await update.message.reply_text(
            f"Topup №{t.id}
UserID: {t.user_id}
Method: {t.method.value}
Amount: {t.amount} AZN",
            reply_markup=kb
        )

async def admin_router(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    if not update.callback_query:
        return
    cq = update.callback_query
    data = cq.data or ""
    await cq.answer()
    if data.startswith("drv|"):
        _, action, dpid_s = data.split("|", 2)
        dpid = int(dpid_s)
        dp = db.query(DriverProfile).filter_by(id=dpid).one_or_none()
        if not dp:
            await cq.edit_message_text("Tapılmadı.")
            return
        dp.status = DriverStatus.approved if action == "approve" else DriverStatus.rejected
        db.commit()
        await cq.edit_message_text(f"OK: driver {dpid} -> {dp.status.value}")
        return

    if data.startswith("top|"):
        from ..models import Wallet
        _, action, tid_s = data.split("|", 2)
        tid = int(tid_s)
        t = db.query(Topup).filter_by(id=tid).one_or_none()
        if not t or t.status != TopupStatus.pending:
            await cq.edit_message_text("Topup tapılmadı / artıq qərar verilib.")
            return
        if action == "approve":
            w = db.query(Wallet).filter_by(user_id=t.user_id).one_or_none()
            if not w:
                await cq.edit_message_text("Wallet tapılmadı.")
                return
            w.balance = (Decimal(str(w.balance)) + Decimal(str(t.amount))).quantize(Decimal("0.01"))
            t.status = TopupStatus.approved
        else:
            t.status = TopupStatus.rejected
        t.decided_at = datetime.utcnow()
        t.decided_by = "admin_bot"
        db.commit()
        await cq.edit_message_text(f"OK: topup {tid} -> {t.status.value}")
        return

def build_handlers():
    return [
        CommandHandler("start", start),
        CommandHandler("pending_drivers", lambda u,c: None),
        CommandHandler("pending_topups", lambda u,c: None),
        CallbackQueryHandler(lambda u,c: None),
    ]
