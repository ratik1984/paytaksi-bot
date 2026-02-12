from __future__ import annotations

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    CommandHandler, MessageHandler, CallbackQueryHandler, ContextTypes, filters
)

STATE_PICKUP = "pickup"
STATE_DEST_QUERY = "dest_query"

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    await update.message.reply_text(
        "Salam! PayTaksi sərnişin botuna xoş gəldin.\n"
        "Zəhmət olmasa, lokasiyanı paylaş (📎 → Location)."
    )
    context.user_data["state"] = STATE_PICKUP

async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.location:
        return

    context.user_data["pickup_lat"] = update.message.location.latitude
    context.user_data["pickup_lon"] = update.message.location.longitude

    await update.message.reply_text(
        "Gedəcəyin yeri yaz (məs: Nizami m/st və ya 28 May).\n"
        "Yaxın alternativlər çıxacaq."
    )
    context.user_data["state"] = STATE_DEST_QUERY

def build_handlers():
    return [
        CommandHandler("start", start),
        MessageHandler(filters.LOCATION, handle_location),
        MessageHandler(filters.TEXT & ~filters.COMMAND, lambda u, c: None),
        CallbackQueryHandler(lambda u, c: None),
    ]
