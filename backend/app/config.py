from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    # Telegram bot tokens
    PASSENGER_BOT_TOKEN: str = Field(default="")
    DRIVER_BOT_TOKEN: str = Field(default="")
    ADMIN_BOT_TOKEN: str = Field(default="")

    # Public URL of your Render service (used in bot buttons)
    PUBLIC_BASE_URL: str = Field(default="http://localhost:8000")

    # Admin panel credentials (as requested)
    ADMIN_USERNAME: str = Field(default="Ratik")
    ADMIN_PASSWORD: str = Field(default="0123456789")

    # Security
    SESSION_SECRET: str = Field(default="change_me_please")

    # Database
    DATABASE_URL: str = Field(default="sqlite:////var/data/paytaksi.db")

    # Pricing
    COMMISSION_RATE: float = Field(default=0.10)
    BASE_FARE_AZN: float = Field(default=3.50)
    BASE_DISTANCE_KM: float = Field(default=3.0)
    PER_KM_AZN: float = Field(default=0.40)
    DRIVER_MIN_BALANCE: float = Field(default=-10.0)

    # Driver onboarding
    DRIVER_MIN_CAR_YEAR: int = Field(default=2010)
    DRIVER_ALLOWED_COLORS: str = Field(default="ağ,qara,qırmızı,boz,mavi,sarı,yaşıl")

    # Matching
    MATCH_RADIUS_KM: float = Field(default=5.0)

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
