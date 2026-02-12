from __future__ import annotations

from decimal import Decimal
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy.orm import Session

from ..config import PAYTAKSI_PASSENGER_BOT_TOKEN, PAYTAKSI_DRIVER_BOT_TOKEN
from ..db import SessionLocal
from ..models import Role, Ride, RideStatus
from ..services.pricing import calc_fare, calc_commission
from ..services.geo import haversine_km
from ..services.assign import pick_nearest_driver
from ..bots.common import get_or_create_user
from .webapp_auth import parse_init_data, validate_init_data


router = APIRouter()


def _read_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


@router.get("/webapp/passenger", response_class=HTMLResponse)
async def webapp_passenger(request: Request):
    # Simple static HTML (served by FastAPI). Telegram Mini App opens this URL.
    return HTMLResponse(_read_file("app/templates/webapp_passenger.html"))


@router.get("/webapp/driver", response_class=HTMLResponse)
async def webapp_driver(request: Request):
    return HTMLResponse(_read_file("app/templates/webapp_driver.html"))


@router.get("/webapp/health")
async def webapp_health():
    return {"ok": True}


@router.post("/api/webapp/passenger/create_ride")
async def api_create_ride(payload: dict):
    """
    Create a ride from Telegram Mini App.

    Expected payload:
      {
        "initData": "<Telegram WebApp initData>",
        "pickup": {"lat": 40.4, "lon": 49.8, "address": "..."},
        "dest": {"lat": 40.3, "lon": 49.9, "address": "..."}
      }
    """
    init_data = (payload.get("initData") or "").strip()
    if not init_data:
        raise HTTPException(status_code=400, detail="initData is required")

    # Validate initData using PASSENGER bot token (Mini App should be opened from passenger bot)
    if not validate_init_data(init_data, PAYTAKSI_PASSENGER_BOT_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid initData")

    data = parse_init_data(init_data)
    user = data.get("user") or {}
    tg_id = user.get("id")
    full_name = (user.get("first_name") or "") + (" " + user.get("last_name") if user.get("last_name") else "")
    full_name = full_name.strip() or (user.get("username") or "")
    if not tg_id:
        raise HTTPException(status_code=400, detail="initData user.id missing")

    pickup = payload.get("pickup") or {}
    dest = payload.get("dest") or {}
    try:
        plat = float(pickup.get("lat"))
        plon = float(pickup.get("lon"))
        dlat = float(dest.get("lat"))
        dlon = float(dest.get("lon"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid coordinates")

    pickup_addr = str(pickup.get("address") or "")[:255]
    dest_addr = str(dest.get("address") or "")[:255]

    # calc
    dkm = haversine_km(plat, plon, dlat, dlon)
    fare: Decimal = calc_fare(dkm)
    comm: Decimal = calc_commission(fare)

    db: Session = SessionLocal()
    try:
        passenger = get_or_create_user(db, int(tg_id), Role.passenger, full_name)
        ride = Ride(
            passenger_user_id=passenger.id,
            pickup_lat=str(plat),
            pickup_lon=str(plon),
            pickup_address=pickup_addr,
            dest_lat=str(dlat),
            dest_lon=str(dlon),
            dest_address=dest_addr,
            distance_km=dkm,
            fare_azn=fare,
            commission_azn=comm,
            status=RideStatus.new,
        )
        db.add(ride)
        db.commit()
        db.refresh(ride)

        driver = pick_nearest_driver(db, plat, plon)
        driver_tg = None
        if driver:
            ride.driver_user_id = driver.id
            ride.status = RideStatus.offered
            db.commit()
            driver_tg = driver.telegram_id

        return JSONResponse(
            {
                "ride_id": ride.id,
                "distance_km": float(dkm),
                "fare_azn": str(fare),
                "commission_azn": str(comm),
                "assigned_driver_tg": driver_tg,
            }
        )
    finally:
        db.close()


@router.post("/api/webapp/driver/my_rides")
async def api_driver_my_rides(payload: dict):
    init_data = (payload.get("initData") or "").strip()
    if not init_data:
        raise HTTPException(status_code=400, detail="initData is required")

    # Validate initData using DRIVER bot token (Mini App should be opened from driver bot)
    if not validate_init_data(init_data, PAYTAKSI_DRIVER_BOT_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid initData")

    data = parse_init_data(init_data)
    user = data.get("user") or {}
    tg_id = user.get("id")
    if not tg_id:
        raise HTTPException(status_code=400, detail="initData user.id missing")

    db: Session = SessionLocal()
    try:
        driver = get_or_create_user(db, int(tg_id), Role.driver, (user.get("first_name") or ""))
        rides = (
            db.query(Ride)
            .filter(Ride.driver_user_id == driver.id)
            .order_by(Ride.created_at.desc())
            .limit(20)
            .all()
        )
        items = []
        for r in rides:
            items.append(
                {
                    "id": r.id,
                    "status": getattr(r.status, "value", str(r.status)),
                    "pickup_address": r.pickup_address,
                    "dropoff_address": r.dest_address,
                    "fare_azn": str(r.fare_azn),
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
            )
        return {"rides": items}
    finally:
        db.close()


@router.post("/api/webapp/driver/accept_ride")
async def api_driver_accept_ride(payload: dict):
    init_data = (payload.get("initData") or "").strip()
    ride_id = payload.get("ride_id")
    if not init_data or not ride_id:
        raise HTTPException(status_code=400, detail="initData and ride_id required")
    data = parse_init_data(init_data)
    if not verify_init_data(init_data, bot_token=PAYTAKSI_DRIVER_BOT_TOKEN):
        raise HTTPException(status_code=401, detail="Bad initData")
    user = data.get("user") or {}
    telegram_id = int(user.get("id"))
    full_name = (user.get("first_name") or "") + (" " + user.get("last_name") if user.get("last_name") else "")
    db: Session = SessionLocal()
    try:
        drv = get_or_create_user(db, telegram_id=telegram_id, role=Role.driver, full_name=full_name.strip())
        ride = db.query(Ride).filter(Ride.id == int(ride_id)).one_or_none()
        if not ride:
            raise HTTPException(status_code=404, detail="Ride not found")
        if ride.status not in (RideStatus.pending, RideStatus.assigned):
            raise HTTPException(status_code=400, detail=f"Ride status is {ride.status}")
        ride.driver_id = drv.id
        ride.status = RideStatus.accepted
        db.commit()
        return JSONResponse({"ok": True, "ride_id": ride.id})
    finally:
        db.close()


