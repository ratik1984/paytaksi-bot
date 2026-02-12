import os
from dotenv import load_dotenv

load_dotenv()

def env(name: str, default: str | None = None) -> str:
    val = os.getenv(name, default)
    if val is None or val == "":
        raise RuntimeError(f"Missing required env var: {name}")
    return val

PAYTAKSI_PASSENGER_BOT_TOKEN = os.getenv("PAYTAKSI_PASSENGER_BOT_TOKEN", "")
PAYTAKSI_DRIVER_BOT_TOKEN = os.getenv("PAYTAKSI_DRIVER_BOT_TOKEN", "")
PAYTAKSI_ADMIN_BOT_TOKEN = os.getenv("PAYTAKSI_ADMIN_BOT_TOKEN", "")

BASE_URL = os.getenv("BASE_URL", "http://localhost:8000").rstrip("/")

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./paytaksi.db")

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "Ratik")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "0123456789")

SECRET_KEY = os.getenv("SECRET_KEY", "change-me")
