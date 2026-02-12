from __future__ import annotations

from decimal import Decimal
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path

from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import User, Role, Ride, RideStatus, DriverProfile, DriverStatus
from ..services.geo import haversine_km
from ..services.pricing import calc_fare, calc_commission, DEFAULT_COMMISSION_RATE
from ..config import PAYTAKSI_PASSENGER_BOT_TOKEN, PAYTAKSI_DRIVER_BOT_TOKEN
from .webapp_auth import validate_init_data, parse_init_data

router = APIRouter()

BASE_DIR = Path(__file__).resolve().parents[1]  # app/
TEMPLATES_DIR = BASE_DIR / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

@router.get("/webapp/passenger", response_class=HTMLResponse)
def webapp_passenger(request: Request):
    return templates.TemplateResponse("webapp_passenger.html", {"request": request})

@router.get("/webapp/driver", response_class=HTMLResponse)
def webapp_driver(request: Request):
    return templates.TemplateResponse("webapp_driver.html", {"request": request})

def db_session() -> Session:
    return SessionLocal()

def _get_or_create_user(db: Session, telegram_id: int, name: str, role: Role) -> User:
    u = db.query(User).filter(User.telegram_id == telegram_id).first()
    if u:
        # allow role upgrade only if empty; otherwise keep
        if u.role != role:
            u.role = role
        if name and (u.name or "") != name:
            u.name = name
        return u
    u = User(telegram_id=telegram_id, name=name or "", role=role)
    db.add(u)
    db.flush()
    return u

@router.post("/api/webapp/passenger/create_ride")
async def api_create_ride(payload: dict):
    init_data = (payload.get("initData") or "").strip()
    if not init_data:
        return JSONResponse({"ok": False, "error": "initData yoxdur (Mini App bot içindən açılmalıdır)."}, status_code=400)

    # validate against passenger bot token
    if not validate_init_data(init_data, PAYTAKSI_PASSENGER_BOT_TOKEN):
        return JSONResponse({"ok": False, "error": "Telegram initData doğrulanmadı."}, status_code=401)

    user = parse_init_data(init_data)

    pickup = payload.get("pickup") or payload.get("pickup_loc") or {}
    dest = payload.get("dest") or payload.get("destination") or {}

    try:
        plat = float(pickup.get("lat"))
        plon = float(pickup.get("lon"))
        dlat = float(dest.get("lat"))
        dlon = float(dest.get("lon"))
    except Exception:
        return JSONResponse({"ok": False, "error": "Lokasiya məlumatı yanlışdır."}, status_code=400)

    pickup_address = (payload.get("pickup_address") or "").strip()
    dest_address = (payload.get("dest_address") or payload.get("destination_text") or "").strip()

    dist_km = haversine_km(plat, plon, dlat, dlon)
    fare = calc_fare(dist_km)
    commission = calc_commission(fare, DEFAULT_COMMISSION_RATE)

    db = db_session()
    try:
        u = _get_or_create_user(db, int(user["id"]), user.get("name",""), Role.passenger)
        ride = Ride(
            passenger_user_id=u.id,
            status=RideStatus.new,
            pickup_lat=str(plat),
            pickup_lon=str(plon),
            pickup_address=pickup_address,
            dest_lat=str(dlat),
            dest_lon=str(dlon),
            dest_address=dest_address,
            distance_km=dist_km,
            fare_azn=fare,
            commission_azn=commission
        )
        db.add(ride)
        db.commit()
        return {"ok": True, "ride_id": ride.id, "distance_km": str(dist_km), "fare": str(fare)}
    finally:
        db.close()

@router.post("/api/webapp/driver/my_rides")
async def api_driver_rides(payload: dict):
    init_data = (payload.get("initData") or "").strip()
    if not init_data:
        return JSONResponse({"ok": False, "error": "initData yoxdur."}, status_code=400)

    if not validate_init_data(init_data, PAYTAKSI_DRIVER_BOT_TOKEN):
        return JSONResponse({"ok": False, "error": "Telegram initData doğrulanmadı."}, status_code=401)

    user = parse_init_data(init_data)
    db = db_session()
    try:
        u = _get_or_create_user(db, int(user["id"]), user.get("name",""), Role.driver)

        dp = db.query(DriverProfile).filter(DriverProfile.user_id == u.id).first()
        if not dp or dp.status != DriverStatus.approved:
            return {"ok": True, "rides": [], "note": "Sürücü hesabı hələ təsdiqlənməyib."}

        rides = (
            db.query(Ride)
            .filter(Ride.status.in_([RideStatus.offered, RideStatus.accepted, RideStatus.arrived, RideStatus.started]))
            .order_by(Ride.created_at.desc())
            .limit(30)
            .all()
        )

        def to_dict(r: Ride):
            return {
                "id": r.id,
                "status": r.status.value if hasattr(r.status, "value") else str(r.status),
                "pickup_address": r.pickup_address,
                "dropoff_address": r.dest_address,
                "fare": str(r.fare_azn),
            }

        return {"ok": True, "rides": [to_dict(r) for r in rides]}
    finally:
        db.close()

@router.post("/api/webapp/driver/accept_ride")
async def api_driver_accept(payload: dict):
    init_data = (payload.get("initData") or "").strip()
    if not init_data:
        return JSONResponse({"ok": False, "error": "initData yoxdur."}, status_code=400)
    if not validate_init_data(init_data, PAYTAKSI_DRIVER_BOT_TOKEN):
        return JSONResponse({"ok": False, "error": "Telegram initData doğrulanmadı."}, status_code=401)

    ride_id = payload.get("ride_id")
    if not ride_id:
        return JSONResponse({"ok": False, "error": "ride_id yoxdur."}, status_code=400)

    user = parse_init_data(init_data)
    db = db_session()
    try:
        u = _get_or_create_user(db, int(user["id"]), user.get("name",""), Role.driver)
        dp = db.query(DriverProfile).filter(DriverProfile.user_id == u.id).first()
        if not dp or dp.status != DriverStatus.approved:
            return JSONResponse({"ok": False, "error": "Sürücü hesabı təsdiqli deyil."}, status_code=403)

        ride = db.query(Ride).filter(Ride.id == int(ride_id)).first()
        if not ride:
            return JSONResponse({"ok": False, "error": "Sifariş tapılmadı."}, status_code=404)
        if ride.status not in [RideStatus.new, RideStatus.offered]:
            return JSONResponse({"ok": False, "error": "Bu sifariş artıq götürülüb və ya bağlanıb."}, status_code=409)

        ride.driver_user_id = u.id
        ride.status = RideStatus.accepted
        db.commit()
        return {"ok": True}
    finally:
        db.close()
