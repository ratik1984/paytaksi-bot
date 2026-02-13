import os
from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from itsdangerous import URLSafeSerializer, BadSignature

from .db import Base, engine, SessionLocal
from .models import Ride
from .bot_runner import build_bot_apps, BotGroup

import requests

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
TEMPLATES_DIR = os.path.join(APP_DIR, "templates")
WEBAPP_DIR = os.path.abspath(os.path.join(APP_DIR, "..", "..", "webapp"))

# Ensure DB tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="PayTaksi")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

def _serializer():
    secret = os.getenv("SESSION_SECRET", "dev-secret")
    return URLSafeSerializer(secret, salt="paytaksi-admin")

def _is_logged(request: Request) -> bool:
    token = request.cookies.get("paytaksi_admin")
    if not token:
        return False
    try:
        data = _serializer().loads(token)
        return data.get("u") == os.getenv("ADMIN_USERNAME","Ratik")
    except BadSignature:
        return False

@app.get("/", response_class=JSONResponse)
def root():
    return {"status": "PayTaksi API running", "webapp": "/webapp/?from=passenger", "admin": "/admin"}

@app.get("/webapp/", response_class=HTMLResponse)
def webapp(from_: str = "passenger"):
    # serve single page app
    index_path = os.path.join(WEBAPP_DIR, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()
    return HTMLResponse(html)

@app.get("/api/places", response_class=JSONResponse)
def places(q: str):
    # OpenStreetMap Nominatim autocomplete (public)
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": q, "format": "json", "addressdetails": 1, "limit": 6},
            headers={"User-Agent": "PayTaksi/1.0 (demo)"},
            timeout=10,
        )
        r.raise_for_status()
        return {"results": r.json()}
    except Exception as e:
        return {"results": [], "error": str(e)}

def calc_price(distance_km: float) -> float:
    base = 3.50
    if distance_km <= 3:
        return base
    extra = (distance_km - 3) * 0.40
    return round(base + extra, 2)

@app.post("/api/rides", response_class=JSONResponse)
def create_ride(payload: dict):
    pickup = (payload.get("pickup") or "").strip()
    dropoff = (payload.get("dropoff") or "").strip()
    if not pickup or not dropoff:
        return JSONResponse({"ok": False, "error": "pickup/dropoff required"}, status_code=400)

    # demo: distance unknown without routing; set 3km for now
    price = calc_price(3.0)

    db = SessionLocal()
    try:
        ride = Ride(pickup=pickup, dropoff=dropoff, status="REQUESTED", price=price)
        db.add(ride)
        db.commit()
        db.refresh(ride)
        return {"ok": True, "ride_id": ride.id, "price": float(price), "status": ride.status}
    finally:
        db.close()

@app.get("/admin", response_class=HTMLResponse)
def admin_login_page(request: Request):
    return templates.TemplateResponse("admin_login.html", {
        "request": request,
        "error": None,
        "admin_username": os.getenv("ADMIN_USERNAME","Ratik"),
        "admin_password": os.getenv("ADMIN_PASSWORD","0123456789"),
    })

@app.post("/admin/login")
def admin_login(request: Request, username: str = Form(...), password: str = Form(...)):
    if username == os.getenv("ADMIN_USERNAME","Ratik") and password == os.getenv("ADMIN_PASSWORD","0123456789"):
        token = _serializer().dumps({"u": username})
        resp = RedirectResponse(url="/admin/panel", status_code=302)
        resp.set_cookie("paytaksi_admin", token, httponly=True, samesite="lax", secure=True)
        return resp
    return templates.TemplateResponse("admin_login.html", {
        "request": request,
        "error": "Login və ya parol yanlışdır",
        "admin_username": os.getenv("ADMIN_USERNAME","Ratik"),
        "admin_password": os.getenv("ADMIN_PASSWORD","0123456789"),
    })

@app.get("/admin/logout")
def admin_logout():
    resp = RedirectResponse(url="/admin", status_code=302)
    resp.delete_cookie("paytaksi_admin")
    return resp

@app.get("/admin/panel", response_class=HTMLResponse)
def admin_panel(request: Request):
    if not _is_logged(request):
        return RedirectResponse(url="/admin", status_code=302)

    db = SessionLocal()
    try:
        rides = db.query(Ride).order_by(Ride.id.desc()).limit(50).all()
        rides_data = [{
            "id": r.id,
            "pickup": r.pickup,
            "dropoff": r.dropoff,
            "status": r.status,
            "price": str(r.price),
            "created_at": str(r.created_at),
        } for r in rides]
    finally:
        db.close()

    return templates.TemplateResponse("admin_panel.html", {"request": request, "rides": rides_data})

@app.on_event("startup")
def startup():
    if os.getenv("RUN_BOTS_IN_WEB","0") != "1":
        return
    base_url = os.getenv("PUBLIC_BASE_URL") or os.getenv("API_BASE") or ""
    base_url = base_url.rstrip("/")
    if not base_url:
        # bots need base url to build buttons
        return
    apps = build_bot_apps(base_url)
    if not apps:
        return
    group = BotGroup(apps)
    group.start_in_thread()
    app.state.bot_group = group
