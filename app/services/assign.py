from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import User, Role
from .geo import haversine_km


def pick_nearest_driver(db: Session, lat: float, lon: float):
    """Pick nearest approved driver with balance > -10."""
    drivers = (
        db.query(User)
        .filter(User.role == Role.driver)
        .filter(User.is_approved == True)
        .filter(User.balance > -10)
        .all()
    )
    best = None
    best_d = None
    for d in drivers:
        if d.last_lat is None or d.last_lon is None:
            continue
        try:
            dl = haversine_km(lat, lon, float(d.last_lat), float(d.last_lon))
        except Exception:
            continue
        if best_d is None or dl < best_d:
            best = d
            best_d = dl
    return best
