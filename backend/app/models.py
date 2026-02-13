from __future__ import annotations

from datetime import datetime

from sqlalchemy import String, Integer, Float, DateTime, ForeignKey, Boolean, LargeBinary
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tg_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    role: Mapped[str] = mapped_column(String(20), index=True)  # passenger/driver
    full_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DriverProfile(Base):
    __tablename__ = "driver_profiles"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    car_year: Mapped[int] = mapped_column(Integer)
    car_color: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending/approved/rejected
    balance: Mapped[float] = mapped_column(Float, default=0.0)
    is_online: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DriverLocation(Base):
    __tablename__ = "driver_locations"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DriverDocument(Base):
    __tablename__ = "driver_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(50))  # id_card/driver_license/tech_passport
    side: Mapped[str] = mapped_column(String(10))      # front/back
    filename: Mapped[str] = mapped_column(String(200))
    mime: Mapped[str] = mapped_column(String(120))
    content: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Ride(Base):
    __tablename__ = "rides"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    passenger_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    driver_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)

    pickup_lat: Mapped[float] = mapped_column(Float)
    pickup_lng: Mapped[float] = mapped_column(Float)
    dest_lat: Mapped[float] = mapped_column(Float)
    dest_lng: Mapped[float] = mapped_column(Float)
    pickup_address: Mapped[str] = mapped_column(String(300))
    dest_address: Mapped[str] = mapped_column(String(300))

    distance_km: Mapped[float] = mapped_column(Float)
    fare_azn: Mapped[float] = mapped_column(Float)
    commission_azn: Mapped[float] = mapped_column(Float)

    status: Mapped[str] = mapped_column(String(20), default="requested")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TopUpRequest(Base):
    __tablename__ = "topup_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    driver_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    amount_azn: Mapped[float] = mapped_column(Float)
    method: Mapped[str] = mapped_column(String(20))  # card2card / m10
    status: Mapped[str] = mapped_column(String(20), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(String(500))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
