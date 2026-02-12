from __future__ import annotations

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    CommandHandler, MessageHandler, CallbackQueryHandler, ContextTypes, filters
)
from sqlalchemy.orm import Session

from ..models import Role, Ride, RideStatus
from ..services.geocode import search_places, reverse_geocode
from ..services.geo import haversine_km
from ..services.pricing import calc_fare, calc_commission
from ..services.assign import pick_nearest_driver
from .common import get_or_create_user

STATE_PICKUP = "pickup"
STATE_DEST_QUERY = "dest_query"


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    await update.message.reply_text(
        "Salam! PayTaksi sərnişin botuna xoş gəldin.\n"
        "Zəhmət olmasa lokasiyanı paylaş (📎 → Location)."
    )
    context.user_data["state"] = STATE_PICKUP


async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.location:
        return

    context.user_data["pickup_lat"] = update.message.location.latitude
    context.user_data["pickup_lon"] = update.message.location.longitude

    addr = ""
    try:
        addr = reverse_geocode(
            float(context.user_data["pickup_lat"]),
            float(context.user_data["pickup_lon"]),
        )
    except Exception:
        addr = ""
    context.user_data["pickup_addr"] = addr

    await update.message.reply_text(
        "Gedəcəyin yeri yaz (məs: Nizami m/st və ya 28 May).\n"
        "Alternativ yaxın yerlər çıxacaq."
    )
    context.user_data["state"] = STATE_DEST_QUERY


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if context.user_data.get("state") != STATE_DEST_QUERY:
        return

    q = (update.message.text or "").strip()
    if len(q) < 3:
        await update.message.reply_text("Daha dəqiq yaz (ən az 3 simvol).")
        return

    try:
        results = search_places(q, limit=5, country_codes="az")
    except Exception:
        await update.message.reply_text("Axtarışda problem oldu. Yenidən yoxla.")
        return

    if not results:
        await update.message.reply_text("Nəticə tapılmadı. Başqa yer yaz.")
        return

    buttons = []
    for r in results:
        title = (r.get("display_name", "") or "")[:60]
        lat = r.get("lat")
        lon = r.get("lon")
        if not lat or not lon:
            continue
        buttons.append([InlineKeyboardButton(title, callback_data=f"dest|{lat}|{lon}|{title}")])

    if not buttons:
        await update.message.reply_text("Nəticə tapılmadı. Başqa yer yaz.")
        return

    await update.message.reply_text("Seç:", reply_markup=InlineKeyboardMarkup(buttons))


async def choose_dest(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    cq = update.callback_query
    await cq.answer()

    data = (cq.data or "")
    if not data.startswith("dest|"):
        return

    try:
        _, lat_s, lon_s, title = data.split("|", 3)
        dest_lat = float(lat_s)
        dest_lon = float(lon_s)
    except Exception:
        await cq.edit_message_text("Seçim oxunmadı. Yenidən cəhd et.")
        return

    pickup_lat = float(context.user_data.get("pickup_lat", 0))
    pickup_lon = float(context.user_data.get("pickup_lon", 0))
    if pickup_lat == 0 or pickup_lon == 0:
        await cq.edit_message_text("Pick-up lokasiya tapılmadı. /start ilə yenidən başla.")
        return

    dkm = haversine_km(pickup_lat, pickup_lon, dest_lat, dest_lon)
    fare = calc_fare(dkm)
    comm = calc_commission(fare)

    passenger_tg = cq.from_user.id
    passenger = get_or_create_user(db, passenger_tg, Role.passenger, cq.from_user.full_name)

    ride = Ride(
        passenger_user_id=passenger.id,
        pickup_lat=str(pickup_lat),
        pickup_lon=str(pickup_lon),
        pickup_address=(context.user_data.get("pickup_addr", "") or "")[:255],
        dest_lat=str(dest_lat),
        dest_lon=str(dest_lon),
        dest_address=(title or "")[:255],
        distance_km=dkm,
        fare_azn=fare,
        commission_azn=comm,
        status=RideStatus.new,
    )
    db.add(ride)
    db.commit()
    db.refresh(ride)

    driver = pick_nearest_driver(db, pickup_lat, pickup_lon)
    if not driver:
        await cq.edit_message_text(
            f"Sifariş yaradıldı (№{ride.id}).\n"
            f"Məsafə ~ {dkm} km\n"
            f"Təxmini qiymət: {fare} AZN\n\n"
            "Hazırda yaxın təsdiqli sürücü tapılmadı."
        )
        return

    ride.status = RideStatus.offered
    ride.driver_user_id = driver.id
    db.commit()

    await cq.edit_message_text(
        f"Sifariş yaradıldı (№{ride.id}).\n"
        f"Məsafə ~ {dkm} km\n"
        f"Təxmini qiymət: {fare} AZN\n\n"
        "Sürücüyə təklif göndərildi. Cavab gözləyirik."
    )


def build_handlers():
    return [
        CommandHandler("start", start),
        MessageHandler(filters.LOCATION, handle_location),
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text),
        CallbackQueryHandler(lambda u, c: None),  # db-bound in app.main
    ]
