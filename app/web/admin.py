from __future__ import annotations
from decimal import Decimal
from datetime import datetime
from fastapi import APIRouter, Request, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from ..db import get_db
from ..config import ADMIN_USERNAME, ADMIN_PASSWORD, SECRET_KEY
from ..models import (
    User, Role, DriverProfile, DriverStatus, Ride, RideStatus, Topup, TopupStatus, Wallet, Setting
)
from starlette.middleware.sessions import SessionMiddleware

templates = Jinja2Templates(directory="app/web/templates")
router = APIRouter()

def _is_logged_in(request: Request) -> bool:
    return bool(request.session.get("admin"))

def _require_login(request: Request):
    if not _is_logged_in(request):
        return RedirectResponse(url="/admin/login", status_code=302)

@router.get("/admin/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request, "err": ""})

@router.post("/admin/login")
def login_do(request: Request, username: str = Form(...), password: str = Form(...)):
    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
        request.session["admin"] = True
        return RedirectResponse(url="/admin", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request, "err": "Yanlış login/parol."})

@router.get("/admin/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/admin/login", status_code=302)

@router.get("/admin", response_class=HTMLResponse)
def dashboard(request: Request, db: Session = Depends(get_db)):
    r = _require_login(request)
    if r: return r

    total_drivers = db.query(User).filter(User.role == Role.driver).count()
    pending_drivers = db.query(DriverProfile).filter(DriverProfile.status == DriverStatus.pending).count()
    total_rides = db.query(Ride).count()
    pending_topups = db.query(Topup).filter(Topup.status == TopupStatus.pending).count()

    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "total_drivers": total_drivers,
        "pending_drivers": pending_drivers,
        "total_rides": total_rides,
        "pending_topups": pending_topups,
    })

@router.get("/admin/drivers", response_class=HTMLResponse)
def drivers(request: Request, db: Session = Depends(get_db)):
    r = _require_login(request)
    if r: return r
    drivers = (
        db.query(User, DriverProfile, Wallet)
        .join(DriverProfile, DriverProfile.user_id == User.id)
        .join(Wallet, Wallet.user_id == User.id)
        .order_by(DriverProfile.id.desc())
        .all()
    )
    return templates.TemplateResponse("drivers.html", {"request": request, "drivers": drivers})

@router.post("/admin/drivers/{dpid}/set_status")
def set_driver_status(request: Request, dpid: int, status: str = Form(...), db: Session = Depends(get_db)):
    r = _require_login(request)
    if r: return r
    dp = db.query(DriverProfile).filter_by(id=dpid).one_or_none()
    if dp:
        if status in {"approved","rejected","pending"}:
            dp.status = DriverStatus(status)
            db.commit()
    return RedirectResponse(url="/admin/drivers", status_code=302)

@router.get("/admin/topups", response_class=HTMLResponse)
def topups(request: Request, db: Session = Depends(get_db)):
    r = _require_login(request)
    if r: return r
    items = db.query(Topup).order_by(Topup.id.desc()).limit(200).all()
    return templates.TemplateResponse("topups.html", {"request": request, "items": items})

@router.post("/admin/topups/{tid}/decide")
def decide_topup(request: Request, tid: int, action: str = Form(...), db: Session = Depends(get_db)):
    r = _require_login(request)
    if r: return r
    t = db.query(Topup).filter_by(id=tid).one_or_none()
    if not t or t.status != TopupStatus.pending:
        return RedirectResponse(url="/admin/topups", status_code=302)
    w = db.query(Wallet).filter_by(user_id=t.user_id).one_or_none()
    if action == "approve" and w:
        w.balance = (Decimal(str(w.balance)) + Decimal(str(t.amount))).quantize(Decimal("0.01"))
        t.status = TopupStatus.approved
    else:
        t.status = TopupStatus.rejected
    t.decided_at = datetime.utcnow()
    t.decided_by = "web_admin"
    db.commit()
    return RedirectResponse(url="/admin/topups", status_code=302)

@router.get("/admin/rides", response_class=HTMLResponse)
def rides(request: Request, db: Session = Depends(get_db)):
    r = _require_login(request)
    if r: return r
    items = db.query(Ride).order_by(Ride.id.desc()).limit(200).all()
    return templates.TemplateResponse("rides.html", {"request": request, "items": items})

@router.get("/admin/settings", response_class=HTMLResponse)
def settings(request: Request, db: Session = Depends(get_db)):
    r = _require_login(request)
    if r: return r
    current = {s.key: s.value for s in db.query(Setting).all()}
    return templates.TemplateResponse("settings.html", {"request": request, "s": current})

@router.post("/admin/settings")
def settings_save(
    request: Request,
    commission_rate: str = Form(...),
    base_fare: str = Form(...),
    included_km: str = Form(...),
    per_km_after: str = Form(...),
    db: Session = Depends(get_db),
):
    r = _require_login(request)
    if r: return r
    def upsert(k,v):
        s = db.query(Setting).filter_by(key=k).one_or_none()
        if not s:
            s = Setting(key=k, value=v)
            db.add(s)
        else:
            s.value = v
    upsert("commission_rate", commission_rate)
    upsert("base_fare", base_fare)
    upsert("included_km", included_km)
    upsert("per_km_after", per_km_after)
    db.commit()
    return RedirectResponse(url="/admin/settings", status_code=302)
