from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, Depends, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from starlette.templating import Jinja2Templates
from sqlalchemy.orm import Session
from sqlalchemy import select, update

from .config import settings
from .db import Base, engine, get_db
from .models import User, DriverProfile, DriverLocation, DriverDocument, Ride, TopUpRequest, Setting
from .services import haversine_km, calc_fare
from .telegram_utils import tg_send_message


APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent.parent
WEBAPP_DIR = PROJECT_DIR / "webapp"
# Documents are stored in Postgres (BYTEA) so we don't need disk persistence.

app = FastAPI(title="PayTaksi")
app.add_middleware(SessionMiddleware, secret_key=settings.SESSION_SECRET)

templates = Jinja2Templates(directory=str(APP_DIR / "templates"))

# Static assets
app.mount("/webapp", StaticFiles(directory=str(WEBAPP_DIR), html=True), name="webapp")
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static"), html=True), name="static")


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    # ensure dynamic settings exist
    with engine.begin() as conn:
        pass


def get_or_create_user(db: Session, tg_id: int, role: str, full_name: str | None = None):
    u = db.execute(select(User).where(User.tg_id == tg_id)).scalar_one_or_none()
    if u:
        if role and u.role != role:
            u.role = role
            db.add(u)
            db.commit()
        return u
    u = User(tg_id=tg_id, role=role, full_name=full_name)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def require_admin(request: Request):
    if not request.session.get("admin"):
        raise HTTPException(status_code=401, detail="Not logged in")


@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/webapp/")


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------------------------
# Passenger API
# ---------------------------

@app.post("/api/passenger/init")
def passenger_init(tg_id: int = Form(...), full_name: str = Form(""), db: Session = Depends(get_db)):
    u = get_or_create_user(db, tg_id=tg_id, role="passenger", full_name=full_name or None)
    return {"user_id": u.id}


@app.get("/api/destination_autocomplete")
async def destination_autocomplete(q: str):
    if not q or len(q) < 3:
        return []
    # Proxy to Nominatim (OSM) for simple autocomplete
    url = "https://nominatim.openstreetmap.org/search"
    params = {"q": q, "format": "json", "limit": 5, "addressdetails": 1}
    headers = {"User-Agent": "PayTaksi/1.0"}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(url, params=params, headers=headers)
        r.raise_for_status()
        data = r.json()
    out = []
    for item in data:
        out.append({
            "display": item.get("display_name"),
            "lat": float(item["lat"]),
            "lng": float(item["lon"]),
        })
    return out


@app.get("/api/fare_quote")
def fare_quote(pickup_lat: float, pickup_lng: float, dest_lat: float, dest_lng: float):
    dist = haversine_km(pickup_lat, pickup_lng, dest_lat, dest_lng)
    fare, commission = calc_fare(dist)
    return {"distance_km": round(dist, 2), "fare_azn": fare, "commission_azn": commission}


@app.post("/api/passenger/request_ride")
async def request_ride(
    tg_id: int = Form(...),
    full_name: str = Form(""),
    pickup_lat: float = Form(...),
    pickup_lng: float = Form(...),
    pickup_address: str = Form(...),
    dest_lat: float = Form(...),
    dest_lng: float = Form(...),
    dest_address: str = Form(...),
    db: Session = Depends(get_db),
):
    passenger = get_or_create_user(db, tg_id=tg_id, role="passenger", full_name=full_name or None)
    dist = haversine_km(pickup_lat, pickup_lng, dest_lat, dest_lng)
    fare, commission = calc_fare(dist)

    ride = Ride(
        passenger_user_id=passenger.id,
        pickup_lat=pickup_lat,
        pickup_lng=pickup_lng,
        dest_lat=dest_lat,
        dest_lng=dest_lng,
        pickup_address=pickup_address,
        dest_address=dest_address,
        distance_km=dist,
        fare_azn=fare,
        commission_azn=commission,
        status="requested",
        updated_at=datetime.utcnow(),
    )
    db.add(ride)
    db.commit()
    db.refresh(ride)

    # Find nearby available approved drivers
    drivers = db.execute(select(User, DriverProfile, DriverLocation)
                         .join(DriverProfile, DriverProfile.user_id == User.id)
                         .join(DriverLocation, DriverLocation.user_id == User.id)
                         .where(User.role == "driver")
                         .where(DriverProfile.status == "approved")
                         .where(DriverProfile.is_online == True)
                         .where(DriverProfile.balance > settings.DRIVER_MIN_BALANCE)
                         ).all()

    candidates = []
    for u, prof, loc in drivers:
        d = haversine_km(pickup_lat, pickup_lng, loc.lat, loc.lng)
        if d <= settings.MATCH_RADIUS_KM:
            candidates.append((d, u))
    candidates.sort(key=lambda x: x[0])
    candidates = candidates[:5]

    if not candidates:
        await tg_send_message(settings.PASSENGER_BOT_TOKEN, passenger.tg_id,
                              "Hal-hazırda yaxınlıqda aktiv sürücü tapılmadı. Bir az sonra yenə yoxlayın.")
        return {"ride_id": ride.id, "status": "no_drivers"}

    # send offers
    for d, u in candidates:
        text = (
            f"🚕 Yeni sifariş!\n"
            f"Pick-up: {pickup_address}\n"
            f"Destination: {dest_address}\n"
            f"Məsafə: {dist:.2f} km\n"
            f"Gediş haqqı: {fare:.2f} AZN\n"
            f"Komissiya: {commission:.2f} AZN (10%)\n\n"
            f"Qəbul edirsiniz?"
        )
        reply_markup = {
            "inline_keyboard": [
                [
                    {"text": "✅ Qəbul et", "callback_data": f"accept:{ride.id}"},
                    {"text": "❌ İmtina", "callback_data": f"decline:{ride.id}"},
                ]
            ]
        }
        await tg_send_message(settings.DRIVER_BOT_TOKEN, u.tg_id, text, reply_markup=reply_markup)

    await tg_send_message(settings.PASSENGER_BOT_TOKEN, passenger.tg_id,
                          f"Sifarişiniz göndərildi. Yaxın sürücülərə təklif getdi (Ride #{ride.id}).")

    return {"ride_id": ride.id, "status": "offered"}


@app.post("/api/passenger/cancel")
def cancel_ride(ride_id: int = Form(...), tg_id: int = Form(...), db: Session = Depends(get_db)):
    passenger = db.execute(select(User).where(User.tg_id == tg_id)).scalar_one_or_none()
    if not passenger:
        raise HTTPException(status_code=404, detail="Passenger not found")
    ride = db.execute(select(Ride).where(Ride.id == ride_id, Ride.passenger_user_id == passenger.id)).scalar_one_or_none()
    if not ride:
        raise HTTPException(status_code=404, detail="Ride not found")
    if ride.status in ("completed", "canceled"):
        return {"ok": True, "status": ride.status}
    ride.status = "canceled"
    ride.updated_at = datetime.utcnow()
    db.add(ride)
    db.commit()
    return {"ok": True, "status": "canceled"}


# ---------------------------
# Driver API
# ---------------------------

@app.post("/api/driver/init")
def driver_init(tg_id: int = Form(...), full_name: str = Form(""), db: Session = Depends(get_db)):
    u = get_or_create_user(db, tg_id=tg_id, role="driver", full_name=full_name or None)
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == u.id)).scalar_one_or_none()
    if not prof:
        prof = DriverProfile(user_id=u.id, car_year=settings.DRIVER_MIN_CAR_YEAR, car_color="ağ", status="pending")
        db.add(prof)
        db.commit()
    return {"user_id": u.id}


@app.post("/api/driver/register")
def driver_register(
    tg_id: int = Form(...),
    full_name: str = Form(""),
    car_year: int = Form(...),
    car_color: str = Form(...),
    db: Session = Depends(get_db),
):
    allowed_colors = [c.strip() for c in settings.DRIVER_ALLOWED_COLORS.split(",") if c.strip()]
    if car_year < settings.DRIVER_MIN_CAR_YEAR:
        raise HTTPException(status_code=400, detail=f"Minimum buraxılış ili: {settings.DRIVER_MIN_CAR_YEAR}")
    if car_color not in allowed_colors:
        raise HTTPException(status_code=400, detail=f"Rəng yalnız bunlar ola bilər: {', '.join(allowed_colors)}")

    u = get_or_create_user(db, tg_id=tg_id, role="driver", full_name=full_name or None)
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == u.id)).scalar_one_or_none()
    if not prof:
        prof = DriverProfile(user_id=u.id, car_year=car_year, car_color=car_color, status="pending")
    else:
        prof.car_year = car_year
        prof.car_color = car_color
        prof.status = "pending"
        prof.updated_at = datetime.utcnow()
    db.add(prof)
    db.commit()

    return {"ok": True, "status": "pending"}


@app.post("/api/driver/upload_doc")
def upload_doc(
    tg_id: int = Form(...),
    doc_type: str = Form(...),
    side: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    u = db.execute(select(User).where(User.tg_id == tg_id, User.role == "driver")).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="Driver not found")
    if doc_type not in ("id_card", "driver_license", "tech_passport"):
        raise HTTPException(status_code=400, detail="Invalid doc_type")
    if side not in ("front", "back"):
        raise HTTPException(status_code=400, detail="Invalid side")

    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    doc = DriverDocument(
        user_id=u.id,
        doc_type=doc_type,
        side=side,
        filename=file.filename or f"{doc_type}_{side}",
        mime=file.content_type or "application/octet-stream",
        content=content,
    )
    db.add(doc)
    db.commit()

    return {"ok": True}


@app.post("/api/driver/set_online")
def driver_set_online(tg_id: int = Form(...), online: bool = Form(...), db: Session = Depends(get_db)):
    u = db.execute(select(User).where(User.tg_id == tg_id, User.role == "driver")).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="Driver not found")
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == u.id)).scalar_one_or_none()
    if not prof:
        raise HTTPException(status_code=400, detail="No driver profile")
    prof.is_online = online
    prof.updated_at = datetime.utcnow()
    db.add(prof)
    db.commit()
    return {"ok": True, "online": online}


@app.post("/api/driver/update_location")
def driver_update_location(
    tg_id: int = Form(...), lat: float = Form(...), lng: float = Form(...), db: Session = Depends(get_db)
):
    u = db.execute(select(User).where(User.tg_id == tg_id, User.role == "driver")).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="Driver not found")
    loc = db.execute(select(DriverLocation).where(DriverLocation.user_id == u.id)).scalar_one_or_none()
    if not loc:
        loc = DriverLocation(user_id=u.id, lat=lat, lng=lng, updated_at=datetime.utcnow())
    else:
        loc.lat = lat
        loc.lng = lng
        loc.updated_at = datetime.utcnow()
    db.add(loc)
    db.commit()
    return {"ok": True}


@app.post("/api/driver/topup")
def driver_topup(tg_id: int = Form(...), amount_azn: float = Form(...), method: str = Form(...), db: Session = Depends(get_db)):
    if method not in ("card2card", "m10"):
        raise HTTPException(status_code=400, detail="Invalid method")
    if amount_azn <= 0:
        raise HTTPException(status_code=400, detail="Invalid amount")
    u = db.execute(select(User).where(User.tg_id == tg_id, User.role == "driver")).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="Driver not found")
    req = TopUpRequest(driver_user_id=u.id, amount_azn=amount_azn, method=method, status="pending")
    db.add(req)
    db.commit()
    return {"ok": True, "status": "pending"}


@app.get("/api/driver/status")
def driver_status(tg_id: int, db: Session = Depends(get_db)):
    u = db.execute(select(User).where(User.tg_id == tg_id, User.role == "driver")).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="Driver not found")
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == u.id)).scalar_one_or_none()
    if not prof:
        raise HTTPException(status_code=404, detail="No profile")
    return {"status": prof.status, "balance": prof.balance, "is_online": prof.is_online, "car_year": prof.car_year, "car_color": prof.car_color}


@app.post("/api/driver/accept_offer")
async def driver_accept_offer(ride_id: int = Form(...), tg_id: int = Form(...), db: Session = Depends(get_db)):
    driver = db.execute(select(User).where(User.tg_id == tg_id, User.role == "driver")).scalar_one_or_none()
    if not driver:
        raise HTTPException(status_code=404, detail="Driver not found")
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == driver.id)).scalar_one_or_none()
    if not prof or prof.status != "approved":
        raise HTTPException(status_code=400, detail="Driver not approved")
    if prof.balance <= settings.DRIVER_MIN_BALANCE:
        raise HTTPException(status_code=400, detail="Balance too low")

    ride = db.execute(select(Ride).where(Ride.id == ride_id)).scalar_one_or_none()
    if not ride or ride.status not in ("requested", "offered"):
        raise HTTPException(status_code=404, detail="Ride not available")
    if ride.driver_user_id is not None:
        return {"ok": False, "reason": "Already assigned"}

    ride.driver_user_id = driver.id
    ride.status = "assigned"
    ride.updated_at = datetime.utcnow()
    db.add(ride)
    db.commit()

    passenger = db.execute(select(User).where(User.id == ride.passenger_user_id)).scalar_one_or_none()
    if passenger:
        await tg_send_message(settings.PASSENGER_BOT_TOKEN, passenger.tg_id,
                              f"✅ Sifariş qəbul olundu! Sürücü tapıldı. Ride #{ride.id}\n\nSürücü: {driver.full_name or 'Sürücü'}")

    await tg_send_message(settings.DRIVER_BOT_TOKEN, driver.tg_id,
                          f"✅ Sifarişi qəbul etdiniz. Ride #{ride.id}.\nPick-up: {ride.pickup_address}\nDestination: {ride.dest_address}")

    return {"ok": True}


@app.post("/api/driver/decline_offer")
def driver_decline_offer(ride_id: int = Form(...), tg_id: int = Form(...), db: Session = Depends(get_db)):
    """Driver declined an offer. We currently just acknowledge; ride stays searching."""
    driver = db.execute(select(User).where(User.tg_id == tg_id, User.role == "driver")).scalar_one_or_none()
    if not driver:
        raise HTTPException(status_code=404, detail="Driver not found")
    # no state change required for MVP
    return {"ok": True}


@app.post("/api/driver/complete")
async def driver_complete(ride_id: int = Form(...), tg_id: int = Form(...), db: Session = Depends(get_db)):
    driver = db.execute(select(User).where(User.tg_id == tg_id, User.role == "driver")).scalar_one_or_none()
    if not driver:
        raise HTTPException(status_code=404, detail="Driver not found")
    ride = db.execute(select(Ride).where(Ride.id == ride_id, Ride.driver_user_id == driver.id)).scalar_one_or_none()
    if not ride:
        raise HTTPException(status_code=404, detail="Ride not found")
    if ride.status == "completed":
        return {"ok": True}

    # deduct commission from driver balance
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == driver.id)).scalar_one_or_none()
    prof.balance = round((prof.balance - ride.commission_azn), 2)
    prof.updated_at = datetime.utcnow()

    ride.status = "completed"
    ride.updated_at = datetime.utcnow()

    db.add(prof)
    db.add(ride)
    db.commit()

    passenger = db.execute(select(User).where(User.id == ride.passenger_user_id)).scalar_one_or_none()
    if passenger:
        await tg_send_message(settings.PASSENGER_BOT_TOKEN, passenger.tg_id,
                              f"✅ Sifariş tamamlandı. Ride #{ride.id}.\nGediş haqqı: {ride.fare_azn:.2f} AZN")

    await tg_send_message(settings.DRIVER_BOT_TOKEN, driver.tg_id,
                          f"✅ Ride #{ride.id} tamamlandı. Komissiya çıxıldı: {ride.commission_azn:.2f} AZN.\nYeni balans: {prof.balance:.2f} AZN")
    return {"ok": True, "balance": prof.balance}


# ---------------------------
# Admin panel (simple, server-rendered)
# ---------------------------

@app.get("/admin/login", response_class=HTMLResponse)
def admin_login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request, "error": None})


@app.post("/admin/login", response_class=HTMLResponse)
def admin_login(request: Request, username: str = Form(...), password: str = Form(...)):
    if username == settings.ADMIN_USERNAME and password == settings.ADMIN_PASSWORD:
        request.session["admin"] = True
        return RedirectResponse(url="/admin", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request, "error": "Login və ya parol yanlışdır"})


@app.get("/admin/logout")
def admin_logout(request: Request):
    request.session.pop("admin", None)
    return RedirectResponse(url="/admin/login")


@app.get("/admin", response_class=HTMLResponse)
def admin_index(request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    counts = {
        "pending_drivers": len(db.execute(select(DriverProfile).where(DriverProfile.status == "pending")).scalars().all()),
        "active_rides": len(db.execute(select(Ride).where(Ride.status.in_(["requested", "offered", "assigned"]))).scalars().all()),
        "pending_topups": len(db.execute(select(TopUpRequest).where(TopUpRequest.status == "pending")).scalars().all()),
        "online_drivers": len(db.execute(select(DriverProfile).where(DriverProfile.is_online == True, DriverProfile.status == "approved")).scalars().all()),
    }
    return templates.TemplateResponse("dashboard.html", {"request": request, "counts": counts})


@app.get("/admin/drivers", response_class=HTMLResponse)
def admin_drivers(request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    items = db.execute(
        select(User, DriverProfile)
        .join(DriverProfile, DriverProfile.user_id == User.id)
        .where(User.role == "driver")
        .order_by(DriverProfile.updated_at.desc())
    ).all()
    return templates.TemplateResponse("drivers.html", {"request": request, "items": items})


@app.get("/admin/topups", response_class=HTMLResponse)
def admin_topups(request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    items = db.execute(select(TopUpRequest).order_by(TopUpRequest.created_at.desc()).limit(200)).scalars().all()
    return templates.TemplateResponse("topups.html", {"request": request, "items": items})


@app.get("/admin/settings", response_class=HTMLResponse)
def admin_settings(request: Request):
    require_admin(request)
    return templates.TemplateResponse("settings.html", {"request": request, "settings": settings})


@app.get("/admin/driver/{user_id}", response_class=HTMLResponse)
def admin_driver_view(user_id: int, request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    u = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == user_id)).scalar_one_or_none()
    docs = db.execute(select(DriverDocument).where(DriverDocument.user_id == user_id).order_by(DriverDocument.created_at.desc())).scalars().all()
    return templates.TemplateResponse("driver_view.html", {"request": request, "u": u, "prof": prof, "docs": docs})


@app.get("/admin/doc/{doc_id}")
def admin_doc(doc_id: int, request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    doc = db.execute(select(DriverDocument).where(DriverDocument.id == doc_id)).scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return RedirectResponse(url=f"/admin/docfile/{doc_id}")


@app.get("/admin/docfile/{doc_id}")
def admin_docfile(doc_id: int, request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    doc = db.execute(select(DriverDocument).where(DriverDocument.id == doc_id)).scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return HTMLResponse(f"<img src='/admin/rawfile/{doc_id}' style='max-width:100%;height:auto' />")


@app.get("/admin/rawfile/{doc_id}")
def admin_rawfile(doc_id: int, request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    doc = db.execute(select(DriverDocument).where(DriverDocument.id == doc_id)).scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="File not found")
    return Response(content=doc.content, media_type=doc.mime)


@app.post("/admin/driver/{user_id}/approve")
def admin_approve_driver(user_id: int, request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == user_id)).scalar_one_or_none()
    if prof:
        prof.status = "approved"
        prof.updated_at = datetime.utcnow()
        db.add(prof)
        db.commit()
    u = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if u:
        # notify driver
        import asyncio
        asyncio.create_task(tg_send_message(settings.DRIVER_BOT_TOKEN, u.tg_id, "✅ Sən təsdiq olundun! İndi onlayn olub sifariş ala bilərsən."))
    return RedirectResponse(url=f"/admin/driver/{user_id}", status_code=302)


@app.post("/admin/driver/{user_id}/reject")
def admin_reject_driver(user_id: int, request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == user_id)).scalar_one_or_none()
    if prof:
        prof.status = "rejected"
        prof.updated_at = datetime.utcnow()
        db.add(prof)
        db.commit()
    return RedirectResponse(url=f"/admin/driver/{user_id}", status_code=302)


@app.post("/admin/topup/{topup_id}/approve")
def admin_approve_topup(topup_id: int, request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    req = db.execute(select(TopUpRequest).where(TopUpRequest.id == topup_id)).scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Not found")
    if req.status != "pending":
        return RedirectResponse(url="/admin", status_code=302)

    prof = db.execute(select(DriverProfile).where(DriverProfile.user_id == req.driver_user_id)).scalar_one_or_none()
    if prof:
        prof.balance = round((prof.balance + req.amount_azn), 2)
        prof.updated_at = datetime.utcnow()
        db.add(prof)
    req.status = "approved"
    db.add(req)
    db.commit()

    driver = db.execute(select(User).where(User.id == req.driver_user_id)).scalar_one_or_none()
    if driver:
        import asyncio
        asyncio.create_task(tg_send_message(settings.DRIVER_BOT_TOKEN, driver.tg_id,
                                           f"✅ Balans artırıldı: +{req.amount_azn:.2f} AZN. Yeni balans: {prof.balance:.2f} AZN"))

    return RedirectResponse(url="/admin", status_code=302)


@app.post("/admin/topup/{topup_id}/reject")
def admin_reject_topup(topup_id: int, request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    req = db.execute(select(TopUpRequest).where(TopUpRequest.id == topup_id)).scalar_one_or_none()
    if req:
        req.status = "rejected"
        db.add(req)
        db.commit()
    return RedirectResponse(url="/admin", status_code=302)
