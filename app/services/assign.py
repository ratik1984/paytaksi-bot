from __future__ import annotations
from decimal import Decimal
from sqlalchemy.orm import Session
from ..models import User, Role, DriverProfile, DriverStatus
from .geo import haversine_km

def pick_nearest_driver(db: Session, lat: float, lon: float) -> User | None:
    # Choose nearest approved driver with known last location
    drivers = (
        db.query(User)
        .join(DriverProfile, DriverProfile.user_id == User.id)
        .filter(User.role == Role.driver)
        .filter(DriverProfile.status == DriverStatus.approved)
        .filter(DriverProfile.last_lat.isnot(None))
        .filter(DriverProfile.last_lon.isnot(None))
        .all()
    )
    best = None
    best_d = None
    for u in drivers:
        dp = u.driver
        try:
            d = haversine_km(lat, lon, float(dp.last_lat), float(dp.last_lon))
        except Exception:
            continue
        if best is None or d < best_d:
            best = u
            best_d = d
    return best
