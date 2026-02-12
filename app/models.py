from __future__ import annotations
import enum
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, DateTime, Boolean, ForeignKey, Numeric, Enum, Text, Index
)
from sqlalchemy.orm import relationship
from .db import Base

class Role(str, enum.Enum):
    passenger = "passenger"
    driver = "driver"
    admin = "admin"

class DriverStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"

class RideStatus(str, enum.Enum):
    new = "new"
    offered = "offered"
    accepted = "accepted"
    arrived = "arrived"
    started = "started"
    finished = "finished"
    canceled = "canceled"

class TopupMethod(str, enum.Enum):
    card2card = "card2card"
    m10 = "m10"

class TopupStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    telegram_id = Column(Integer, unique=True, nullable=False, index=True)
    role = Column(Enum(Role), nullable=False)
    name = Column(String(200), default="")
    created_at = Column(DateTime, default=datetime.utcnow)

    wallet = relationship("Wallet", back_populates="user", uselist=False, cascade="all, delete-orphan")
    driver = relationship("DriverProfile", back_populates="user", uselist=False, cascade="all, delete-orphan")

class Wallet(Base):
    __tablename__ = "wallets"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    balance = Column(Numeric(12, 2), default=0)
    updated_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="wallet")

class DriverProfile(Base):
    __tablename__ = "driver_profiles"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    status = Column(Enum(DriverStatus), default=DriverStatus.pending, nullable=False)

    car_year = Column(Integer, nullable=True)
    car_color = Column(String(50), nullable=True)
    car_model = Column(String(120), nullable=True)
    plate = Column(String(50), nullable=True)

    last_lat = Column(String(30), nullable=True)
    last_lon = Column(String(30), nullable=True)
    last_loc_at = Column(DateTime, nullable=True)

    id_front_file_id = Column(String(200), nullable=True)
    id_back_file_id = Column(String(200), nullable=True)
    dl_front_file_id = Column(String(200), nullable=True)
    dl_back_file_id = Column(String(200), nullable=True)
    tech_front_file_id = Column(String(200), nullable=True)
    tech_back_file_id = Column(String(200), nullable=True)

    notes = Column(Text, default="")

    user = relationship("User", back_populates="driver")

class Ride(Base):
    __tablename__ = "rides"
    id = Column(Integer, primary_key=True)
    passenger_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    driver_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)

    status = Column(Enum(RideStatus), default=RideStatus.new, nullable=False)

    pickup_lat = Column(String(30), nullable=False)
    pickup_lon = Column(String(30), nullable=False)
    pickup_address = Column(String(255), default="")

    dest_lat = Column(String(30), nullable=False)
    dest_lon = Column(String(30), nullable=False)
    dest_address = Column(String(255), default="")
    distance_km = Column(Numeric(10, 3), default=0)

    fare_azn = Column(Numeric(12, 2), default=0)
    commission_azn = Column(Numeric(12, 2), default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

class Setting(Base):
    __tablename__ = "settings"
    key = Column(String(80), primary_key=True)
    value = Column(String(255), nullable=False)

class Topup(Base):
    __tablename__ = "topups"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    method = Column(Enum(TopupMethod), nullable=False)
    amount = Column(Numeric(12,2), nullable=False)
    note = Column(String(255), default="")
    status = Column(Enum(TopupStatus), default=TopupStatus.pending, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(String(120), default="")
    decision_note = Column(String(255), default="")

Index("ix_driver_status", DriverProfile.status)
