from sqlalchemy import Column, Integer, String, DateTime, Text, Numeric
from sqlalchemy.sql import func
from .db import Base

class Ride(Base):
    __tablename__ = "rides"
    id = Column(Integer, primary_key=True, index=True)
    pickup = Column(Text, nullable=False)
    dropoff = Column(Text, nullable=False)
    status = Column(String(32), default="REQUESTED", nullable=False)
    price = Column(Numeric(10, 2), default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
