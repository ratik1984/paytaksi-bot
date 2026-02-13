from sqlalchemy import Column, Integer, String, DateTime, Text, Numeric, Boolean, Float, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .db import Base

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    telegram_id = Column(String(32), unique=True, index=True, nullable=False)
    username = Column(String(128), nullable=True)
    role = Column(String(16), default="passenger")  # passenger | driver | admin
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class DriverProfile(Base):
    __tablename__ = "driver_profiles"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    full_name = Column(String(128), nullable=False)
    car_brand = Column(String(64), nullable=True)
    car_model = Column(String(64), nullable=True)
    car_year = Column(Integer, nullable=False)  # min 2010
    car_color = Column(String(16), nullable=False)  # white black red gray blue yellow green
    car_plate = Column(String(32), nullable=True)
    approved = Column(Boolean, default=False, nullable=False)
    online = Column(Boolean, default=False, nullable=False)
    balance = Column(Numeric(12, 2), default=0, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")

class DriverDocument(Base):
    __tablename__ = "driver_documents"
    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(Integer, ForeignKey("driver_profiles.id"), nullable=False, index=True)
    doc_type = Column(String(32), nullable=False)  # id_front,id_back,dl_front,dl_back,reg_front,reg_back
    file_path = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("driver_id", "doc_type", name="uq_driver_doc"),
    )

class DriverLocation(Base):
    __tablename__ = "driver_locations"
    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(Integer, ForeignKey("driver_profiles.id"), unique=True, nullable=False)
    lat = Column(Float, nullable=False)
    lon = Column(Float, nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class BalanceTxn(Base):
    __tablename__ = "balance_txns"
    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(Integer, ForeignKey("driver_profiles.id"), nullable=False, index=True)
    kind = Column(String(32), nullable=False)  # topup, commission, payout, adjustment
    amount = Column(Numeric(12, 2), nullable=False)  # positive/negative
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Ride(Base):
    __tablename__ = "rides"
    id = Column(Integer, primary_key=True, index=True)
    passenger_tid = Column(String(32), nullable=True, index=True)
    pickup_text = Column(Text, nullable=False)
    pickup_lat = Column(Float, nullable=True)
    pickup_lon = Column(Float, nullable=True)
    dropoff_text = Column(Text, nullable=False)
    dropoff_lat = Column(Float, nullable=True)
    dropoff_lon = Column(Float, nullable=True)
    distance_km = Column(Float, default=0)
    duration_min = Column(Float, default=0)
    status = Column(String(32), default="REQUESTED", nullable=False)  # REQUESTED, OFFERED, ACCEPTED, STARTED, COMPLETED, CANCELED
    driver_id = Column(Integer, ForeignKey("driver_profiles.id"), nullable=True, index=True)
    price = Column(Numeric(10, 2), default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class RideOffer(Base):
    __tablename__ = "ride_offers"
    id = Column(Integer, primary_key=True, index=True)
    ride_id = Column(Integer, ForeignKey("rides.id"), nullable=False, index=True)
    driver_id = Column(Integer, ForeignKey("driver_profiles.id"), nullable=False, index=True)
    status = Column(String(16), default="PENDING")  # PENDING, ACCEPTED, DECLINED, EXPIRED
    created_at = Column(DateTime(timezone=True), server_default=func.now())
