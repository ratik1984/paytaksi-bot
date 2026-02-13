from __future__ import annotations

import os
import sys
import threading
import traceback
from pathlib import Path

_started = False
_lock = threading.Lock()


def _run(target, name: str):
    try:
        target()
    except Exception:
        print(f"[bot_runner] {name} crashed:")
        traceback.print_exc()


def start_bots_if_enabled():
    """Start Passenger/Driver/Admin bots inside the web service (Render Free plan friendly).

    Controlled by env var RUN_BOTS_IN_WEB=1 (default: 1 on Render, 0 locally unless set).
    """
    global _started
    with _lock:
        if _started:
            return
        run_flag = os.environ.get("RUN_BOTS_IN_WEB", "").strip()
        if run_flag == "":
            # default: enable on Render, disable elsewhere
            run_flag = "1" if os.environ.get("RENDER", "").lower() == "true" else "0"
        if run_flag != "1":
            print("[bot_runner] RUN_BOTS_IN_WEB disabled; skipping bot startup.")
            _started = True
            return

        # Make project root importable so we can import bots.*
        app_dir = Path(__file__).resolve().parent
        project_dir = app_dir.parent.parent  # <project>/backend/.. => <project>
        sys.path.insert(0, str(project_dir))

        from bots import passenger_bot, driver_bot, admin_bot  # noqa

        threads = [
            threading.Thread(target=lambda: _run(passenger_bot.main, "passenger_bot"), daemon=True),
            threading.Thread(target=lambda: _run(driver_bot.main, "driver_bot"), daemon=True),
            threading.Thread(target=lambda: _run(admin_bot.main, "admin_bot"), daemon=True),
        ]
        for t in threads:
            t.start()

        _started = True
        print("[bot_runner] Bots started inside web service (polling mode).")
