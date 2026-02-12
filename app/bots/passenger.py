from __future__ import annotations
from decimal import Decimal
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
STATE_DEST_CHOSEN = "dest_chosen"

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    await update.message.reply_text(
        "Salam! PayTaksi sərnişin botuna xoş gəldin.\n"
        "Zəhmət olmasa, *lokasiyanı* paylaş (📎 → Location).",
        parse_mode="Markdown"
    )
    context.user_data["state"] = STATE_PICKUP


    context.user_data["state"] = STATE_PICKUP

async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.location:
        return
    context.user_data["pickup_lat"] = update.message.location.latitude
    context.user_data["pickup_lon"] = update.message.location.longitude
    addr = ""
    try:
        addr = reverse_geocode(context.user_data["pickup_lat"], context.user_data["pickup_lon"])
    except Exception:
        addr = ""
    context.user_data["pickup_addr"] = addr
    await update.message.reply_text(
        "Gedəcəyin yeri yaz (məs: 'Nizami m/st' və ya '28 May').
"
        "Alternativ nəticələr təklif edəcəyəm."
    )
    context.user_data["state"] = STATE_DEST_QUERY

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state = context.user_data.get("state")
    if state != STATE_DEST_QUERY:
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
        await update.message.reply_text("Nəticə tapılmadı. Başqa yaz.")
        return
    buttons = []
    for r in results:
        title = r.get("display_name", "")[:60]
        lat = r.get("lat")
        lon = r.get("lon")
        buttons.append([InlineKeyboardButton(title, callback_data=f"dest|{lat}|{lon}|{title}")])
    await update.message.reply_text("Seç:", reply_markup=InlineKeyboardMarkup(buttons))

async def choose_dest(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    q = update.callback_query
    await q.answer()
    data = (q.data or "")
    if not data.startswith("dest|"):
        return
    _, lat, lon, title = data.split("|", 3)
    context.user_data["dest_lat"] = float(lat)
    context.user_data["dest_lon"] = float(lon)
    context.user_data["dest_addr"] = title

    # estimate distance + fare
    dkm = haversine_km(
        float(context.user_data["pickup_lat"]),
        float(context.user_data["pickup_lon"]),
        float(context.user_data["dest_lat"]),
        float(context.user_data["dest_lon"]),
    )
    fare = calc_fare(dkm)
    comm = calc_commission(fare)

    # create ride
    passenger_tg = q.from_user.id
    passenger = get_or_create_user(db, passenger_tg, Role.passenger, q.from_user.full_name)
    ride = Ride(
        passenger_user_id=passenger.id,
        pickup_lat=str(context.user_data["pickup_lat"]),
        pickup_lon=str(context.user_data["pickup_lon"]),
        pickup_address=context.user_data.get("pickup_addr","")[:255],
        dest_lat=str(context.user_data["dest_lat"]),
        dest_lon=str(context.user_data["dest_lon"]),
        dest_address=context.user_data.get("dest_addr","")[:255],
        distance_km=dkm,
        fare_azn=fare,
        commission_azn=comm,
        status=RideStatus.new
    )
    db.add(ride)
    db.commit()
    db.refresh(ride)

    # assign driver (simple nearest)
    driver = pick_nearest_driver(db, float(context.user_data["pickup_lat"]), float(context.user_data["pickup_lon"]))
    if not driver:
        await q.edit_message_text(
            f"Sifariş yaradıldı (№{ride.id}).
"
            f"Məsafə ~ {dkm} km
"
            f"Təxmini qiymət: {fare} AZN

"
            "Hazırda yaxın təsdiqli sürücü tapılmadı. Bir az sonra yenə cəhd edin."
        )
        return

    # offer to driver (driver bot will handle callback)
    ride.status = RideStatus.offered
    ride.driver_user_id = driver.id
    db.commit()

    await q.edit_message_text(
        f"Sifariş yaradıldı (№{ride.id}).
"
        f"Məsafə ~ {dkm} km
"
        f"Təxmini qiymət: {fare} AZN

"
        "Sürücüyə təklif göndərildi. Cavab gözləyirik."
    )

async def passenger_router(update: Update, context: ContextTypes.DEFAULT_TYPE, db: Session):
    # callback route
    if update.callback_query and update.callback_query.data and update.callback_query.data.startswith("dest|"):
        await choose_dest(update, context, db)

def build_handlers():
    return [
        CommandHandler("start", start),
        MessageHandler(filters.LOCATION, handle_location),
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text),
        CallbackQueryHandler(lambda u,c: None),  # placeholder; real handled in main router
    ]
