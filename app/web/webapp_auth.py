from __future__ import annotations

import hmac
import hashlib
import json
from urllib.parse import unquote_plus


def parse_init_data(init_data: str) -> dict:
    """Parse Telegram WebApp initData into a dict.

    initData format: key=value&key2=value2...
    user is JSON.
    """
    out: dict = {}
    for part in init_data.split("&"):
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        out[k] = unquote_plus(v)
    if "user" in out:
        try:
            out["user"] = json.loads(out["user"])
        except Exception:
            pass
    return out


def validate_init_data(init_data: str, bot_token: str) -> bool:
    """Validate Telegram WebApp initData.

    Ref algorithm: build data_check_string from key=value pairs (except hash), sorted by key,
    then compute HMAC-SHA256 with secret = SHA256(bot_token).
    """
    data = parse_init_data(init_data)
    received_hash = data.get("hash")
    if not received_hash:
        return False

    pairs = []
    for k, v in data.items():
        if k == "hash":
            continue
        pairs.append(f"{k}={v}")
    pairs.sort()
    data_check_string = "\n".join(pairs)

    secret_key = hashlib.sha256(bot_token.encode("utf-8")).digest()
    computed = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    # timing-safe compare
    return hmac.compare_digest(computed, received_hash)
