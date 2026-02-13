import httpx


async def tg_send_message(token: str, chat_id: int, text: str, reply_markup: dict | None = None):
    """Thin wrapper around Telegram sendMessage."""
    if not token:
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(url, json=payload)
        except Exception:
            # Intentionally swallow errors: bots may not be configured yet
            return
