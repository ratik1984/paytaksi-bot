import os
import math
import time
from decimal import Decimal
from typing import Optional, Tuple, Dict, Any

from fastapi import FastAPI, Request, Form, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from itsdangerous import URLSafeSerializer, BadSignature

from .db import Base, engine, SessionLocal
from .models import Ride, User, DriverProfile, DriverDocument, DriverLocation, RideOffer, BalanceTxn
from .bot_runner import build_bot_apps, BotGroup

import requests

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
TEMPLATES_DIR = os.path.join(APP_DIR, "templates")
WEBAPP_DIR = os.path.abspath(os.path.join(APP_DIR, "..", "..", "webapp"))
UPLOAD_DIR = os.path.abspath(os.path.join(APP_DIR, "..", "..", "uploads"))

os.makedirs(UPLOAD_DIR, exist_ok=True)

# Ensure DB tables
Base.metadata.create_all(bind=engine)

# Settings (MVP constants)
COMMISSION_RATE = Decimal("0.10")
BASE_FARE = Decimal("3.50")
FREE_KM = Decimal("3.0")
PER_KM_AFTER = Decimal("0.40")
DRIVER_BLOCK_BALANCE = Decimal("-10.00")
ALLOWED_COLORS = {"ag","qara","qirmizi","boz","mavi","sari","yasil"}  # AZ short names

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

def calc_price(distance_km: float) -> Decimal:
    d = Decimal(str(max(distance_km, 0.0)))
    price = BASE_FARE
    if d > FREE_KM:
        price += (d - FREE_KM) * PER_KM_AFTER
    # 2 decimals
    return price.quantize(Decimal("0.01"))

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p = math.pi / 180.0
    dlat = (lat2-lat1)*p
    dlon = (lon2-lon1)*p
    a = math.sin(dlat/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin(dlon/2)**2
    c = 2*math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R*c

def parse_latlon(text: str) -> Optional[Tuple[float,float]]:
    t = (text or "").strip()
    m = None
    # accept "lat,lon"
    if "," in t:
        parts = [p.strip() for p in t.split(",")]
        if len(parts) >= 2:
            try:
                lat = float(parts[0]); lon = float(parts[1])
                if -90 <= lat <= 90 and -180 <= lon <= 180:
                    return (lat, lon)
            except:
                pass
    return None

def geocode(text: str) -> Optional[Tuple[float,float,str]]:
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": text, "format": "json", "addressdetails": 1, "limit": 1},
            headers={"User-Agent": "PayTaksi/1.0 (demo)"},
            timeout=10,
        )
        r.raise_for_status()
        js = r.json()
        if not js:
            return None
        lat = float(js[0]["lat"]); lon = float(js[0]["lon"])
        name = js[0].get("display_name") or text
        return (lat, lon, name)
    except:
        return None

def osrm_route_km_min(p1: Tuple[float,float], p2: Tuple[float,float]) -> Tuple[float,float]:
    # OSRM public demo server (rate limited). coordinates are lon,lat
    lon1, lat1 = p1[1], p1[0]
    lon2, lat2 = p2[1], p2[0]
    url = f"https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}"
    try:
        r = requests.get(url, params={"overview":"false"}, timeout=12, headers={"User-Agent":"PayTaksi/1.0"})
        r.raise_for_status()
        data = r.json()
        routes = data.get("routes") or []
        if not routes:
            raise RuntimeError("no route")
        dist_m = routes[0]["distance"]
        dur_s = routes[0]["duration"]
        return (dist_m/1000.0, dur_s/60.0)
    except:
        # fallback to straight-line * 1.3 approximation
        km = haversine_km(p1[0],p1[1],p2[0],p2[1]) * 1.3
        return (km, km/25.0*60.0)  # 25 km/h avg

def get_or_create_user(db, telegram_id: str, username: Optional[str], role: str):
    u = db.query(User).filter(User.telegram_id == str(telegram_id)).first()
    if not u:
        u = User(telegram_id=str(telegram_id), username=username, role=role)
        db.add(u); db.commit(); db.refresh(u)
    else:
        # keep latest username/role (do not downgrade)
        if username and u.username != username:
            u.username = username
        if role == "driver" and u.role != "driver":
            u.role = "driver"
        db.commit()
    return u

@app.get("/", response_class=JSONResponse)
def root():
    return {
        "status": "PayTaksi API running",
        "webapp_passenger": "/webapp/?from=passenger",
        "webapp_driver": "/webapp/?from=driver",
        "admin": "/admin"
    }

@app.get("/webapp/", response_class=HTMLResponse)
def webapp(from_: str = "passenger"):
    index_path = os.path.join(WEBAPP_DIR, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()
    return HTMLResponse(html)

@app.get("/api/places", response_class=JSONResponse)
def places(q: str):
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

@app.post("/api/driver/register", response_class=JSONResponse)
def driver_register(payload: Dict[str,Any]):
    required = ["telegram_id","full_name","car_year","car_color"]
    for k in required:
        if not payload.get(k):
            return JSONResponse({"ok":False,"error":f"{k} required"}, status_code=400)

    telegram_id = str(payload.get("telegram_id"))
    username = payload.get("username")
    full_name = (payload.get("full_name") or "").strip()
    car_year = int(payload.get("car_year"))
    car_color = (payload.get("car_color") or "").strip().lower()

    if car_year < 2010:
        return JSONResponse({"ok":False,"error":"Minimum 2010"}, status_code=400)
    if car_color not in ALLOWED_COLORS:
        return JSONResponse({"ok":False,"error":"Rəng icazəli deyil"}, status_code=400)

    db = SessionLocal()
    try:
        u = get_or_create_user(db, telegram_id, username, "driver")
        prof = db.query(DriverProfile).filter(DriverProfile.user_id == u.id).first()
        if not prof:
            prof = DriverProfile(
                user_id=u.id,
                full_name=full_name,
                car_brand=(payload.get("car_brand") or "").strip() or None,
                car_model=(payload.get("car_model") or "").strip() or None,
                car_year=car_year,
                car_color=car_color,
                car_plate=(payload.get("car_plate") or "").strip() or None,
                approved=False,
                online=False,
                balance=Decimal("0.00"),
            )
            db.add(prof); db.commit(); db.refresh(prof)
        else:
            prof.full_name = full_name
            prof.car_brand = (payload.get("car_brand") or "").strip() or None
            prof.car_model = (payload.get("car_model") or "").strip() or None
            prof.car_year = car_year
            prof.car_color = car_color
            prof.car_plate = (payload.get("car_plate") or "").strip() or None
            db.commit()
        return {"ok":True,"driver_id":prof.id,"approved":prof.approved}
    finally:
        db.close()

@app.post("/api/driver/upload", response_class=JSONResponse)
def driver_upload(telegram_id: str = Form(...), doc_type: str = Form(...), file: UploadFile = File(...)):
    doc_type = doc_type.strip()
    allowed = {"id_front","id_back","dl_front","dl_back","reg_front","reg_back"}
    if doc_type not in allowed:
        return JSONResponse({"ok":False,"error":"Invalid doc_type"}, status_code=400)

    db = SessionLocal()
    try:
        u = db.query(User).filter(User.telegram_id == str(telegram_id)).first()
        if not u:
            return JSONResponse({"ok":False,"error":"Driver not registered"}, status_code=400)
        prof = db.query(DriverProfile).filter(DriverProfile.user_id == u.id).first()
        if not prof:
            return JSONResponse({"ok":False,"error":"Driver profile missing"}, status_code=400)

        safe_name = f"{prof.id}_{doc_type}_{int(time.time())}_{file.filename}".replace("..","_")
        path = os.path.join(UPLOAD_DIR, safe_name)
        with open(path, "wb") as out:
            out.write(file.file.read())

        existing = db.query(DriverDocument).filter(DriverDocument.driver_id==prof.id, DriverDocument.doc_type==doc_type).first()
        if existing:
            existing.file_path = path
        else:
            db.add(DriverDocument(driver_id=prof.id, doc_type=doc_type, file_path=path))
        db.commit()
        return {"ok":True,"doc_type":doc_type}
    finally:
        db.close()

@app.post("/api/driver/location", response_class=JSONResponse)
def driver_location(payload: Dict[str,Any]):
    telegram_id = str(payload.get("telegram_id") or "").strip()
    lat = payload.get("lat"); lon = payload.get("lon")
    if not telegram_id or lat is None or lon is None:
        return JSONResponse({"ok":False,"error":"telegram_id,lat,lon required"}, status_code=400)

    db = SessionLocal()
    try:
        u = db.query(User).filter(User.telegram_id==telegram_id).first()
        if not u: return JSONResponse({"ok":False,"error":"not registered"}, status_code=400)
        prof = db.query(DriverProfile).filter(DriverProfile.user_id==u.id).first()
        if not prof: return JSONResponse({"ok":False,"error":"profile missing"}, status_code=400)

        loc = db.query(DriverLocation).filter(DriverLocation.driver_id==prof.id).first()
        if not loc:
            loc = DriverLocation(driver_id=prof.id, lat=float(lat), lon=float(lon))
            db.add(loc)
        else:
            loc.lat = float(lat); loc.lon = float(lon)
        db.commit()
        return {"ok":True}
    finally:
        db.close()

@app.post("/api/driver/online", response_class=JSONResponse)
def driver_online(payload: Dict[str,Any]):
    telegram_id = str(payload.get("telegram_id") or "").strip()
    online = bool(payload.get("online"))
    db = SessionLocal()
    try:
        u = db.query(User).filter(User.telegram_id==telegram_id).first()
        if not u: return JSONResponse({"ok":False,"error":"not registered"}, status_code=400)
        prof = db.query(DriverProfile).filter(DriverProfile.user_id==u.id).first()
        if not prof: return JSONResponse({"ok":False,"error":"profile missing"}, status_code=400)

        # balance rule
        if online and Decimal(str(prof.balance)) <= DRIVER_BLOCK_BALANCE:
            return JSONResponse({"ok":False,"error":"Balans -10 və ya aşağıdır. Online ola bilməz."}, status_code=400)

        # only approved drivers can go online
        if online and not prof.approved:
            return JSONResponse({"ok":False,"error":"Admin təsdiqi gözlənilir."}, status_code=400)

        prof.online = online
        db.commit()
        return {"ok":True, "online": prof.online}
    finally:
        db.close()

@app.post("/api/driver/topup_request", response_class=JSONResponse)
def driver_topup(payload: Dict[str,Any]):
    telegram_id = str(payload.get("telegram_id") or "").strip()
    amount = payload.get("amount")
    method = (payload.get("method") or "card2card").strip()
    if not telegram_id or amount is None:
        return JSONResponse({"ok":False,"error":"telegram_id, amount required"}, status_code=400)
    amt = Decimal(str(amount)).quantize(Decimal("0.01"))
    if amt <= 0:
        return JSONResponse({"ok":False,"error":"amount > 0"}, status_code=400)

    # MVP: record txn as pending note; admin will adjust balance manually in panel
    db = SessionLocal()
    try:
        u = db.query(User).filter(User.telegram_id==telegram_id).first()
        if not u: return JSONResponse({"ok":False,"error":"not registered"}, status_code=400)
        prof = db.query(DriverProfile).filter(DriverProfile.user_id==u.id).first()
        if not prof: return JSONResponse({"ok":False,"error":"profile missing"}, status_code=400)
        db.add(BalanceTxn(driver_id=prof.id, kind="topup", amount=amt, note=f"REQUEST:{method}"))
        db.commit()
        return {"ok":True, "requested": str(amt), "method": method}
    finally:
        db.close()

def _resolve_points(pickup: str, dropoff: str):
    p_ll = parse_latlon(pickup)
    d_ll = parse_latlon(dropoff)
    p_name = pickup
    d_name = dropoff
    if not p_ll:
        g = geocode(pickup)
        if g: p_ll = (g[0],g[1]); p_name = g[2]
    if not d_ll:
        g = geocode(dropoff)
        if g: d_ll = (g[0],g[1]); d_name = g[2]
    return p_ll, d_ll, p_name, d_name

@app.post("/api/rides", response_class=JSONResponse)
def create_ride(payload: Dict[str,Any]):
    pickup = (payload.get("pickup") or "").strip()
    dropoff = (payload.get("dropoff") or "").strip()
    passenger_tid = str(payload.get("telegram_id") or "").strip() or None
    if not pickup or not dropoff:
        return JSONResponse({"ok": False, "error": "pickup/dropoff required"}, status_code=400)

    p_ll, d_ll, p_name, d_name = _resolve_points(pickup, dropoff)
    if not p_ll or not d_ll:
        return JSONResponse({"ok":False,"error":"Ünvan tapılmadı. Lat,Lon yazın və ya daha dəqiq ünvan."}, status_code=400)

    dist_km, dur_min = osrm_route_km_min(p_ll, d_ll)
    price = calc_price(dist_km)

    db = SessionLocal()
    try:
        ride = Ride(
            passenger_tid=passenger_tid,
            pickup_text=p_name, pickup_lat=p_ll[0], pickup_lon=p_ll[1],
            dropoff_text=d_name, dropoff_lat=d_ll[0], dropoff_lon=d_ll[1],
            distance_km=float(dist_km), duration_min=float(dur_min),
            status="REQUESTED",
            price=price
        )
        db.add(ride); db.commit(); db.refresh(ride)

        # dispatch to nearby drivers (online+approved, balance>-10)
        offered = dispatch_ride(db, ride.id)

        return {
            "ok": True,
            "ride_id": ride.id,
            "distance_km": round(dist_km, 2),
            "duration_min": round(dur_min, 1),
            "price": str(price),
            "offered_drivers": offered,
            "status": "OFFERED" if offered else "REQUESTED"
        }
    finally:
        db.close()

def dispatch_ride(db, ride_id: int, radius_km: float = 5.0, max_drivers: int = 10) -> int:
    ride = db.query(Ride).filter(Ride.id==ride_id).first()
    if not ride or not ride.pickup_lat or not ride.pickup_lon:
        return 0

    # get candidate drivers
    q = db.query(DriverProfile, DriverLocation).join(
        DriverLocation, DriverLocation.driver_id==DriverProfile.id
    ).filter(
        DriverProfile.approved==True,
        DriverProfile.online==True,
    ).all()

    candidates = []
    for prof, loc in q:
        try:
            if Decimal(str(prof.balance)) <= DRIVER_BLOCK_BALANCE:
                continue
            d = haversine_km(float(ride.pickup_lat), float(ride.pickup_lon), float(loc.lat), float(loc.lon))
            if d <= radius_km:
                candidates.append((d, prof.id))
        except:
            continue

    candidates.sort(key=lambda x: x[0])
    selected = [did for _, did in candidates[:max_drivers]]

    # create offers
    offered = 0
    for did in selected:
        exists = db.query(RideOffer).filter(RideOffer.ride_id==ride.id, RideOffer.driver_id==did).first()
        if exists:
            continue
        db.add(RideOffer(ride_id=ride.id, driver_id=did, status="PENDING"))
        offered += 1

    if offered:
        ride.status = "OFFERED"
    db.commit()

    # try notify via bot (best-effort)
    try_notify_offers(selected, ride)
    return offered

def try_notify_offers(driver_ids, ride: Ride):
    # if driver bot is running, we can send message using Application bot directly
    group = getattr(app.state, "bot_group", None)
    if not group:
        return
    # we don't have driver chat_id mapping yet in MVP; webapp will show pending offers list for drivers
    return

@app.get("/api/driver/offers", response_class=JSONResponse)
def driver_offers(telegram_id: str):
    db = SessionLocal()
    try:
        u = db.query(User).filter(User.telegram_id==str(telegram_id)).first()
        if not u: return {"ok":False,"offers":[]}
        prof = db.query(DriverProfile).filter(DriverProfile.user_id==u.id).first()
        if not prof: return {"ok":False,"offers":[]}

        offers = db.query(RideOffer, Ride).join(Ride, Ride.id==RideOffer.ride_id).filter(
            RideOffer.driver_id==prof.id,
            RideOffer.status=="PENDING",
        ).order_by(RideOffer.id.desc()).limit(20).all()

        out = []
        for o, r in offers:
            out.append({
                "offer_id": o.id,
                "ride_id": r.id,
                "pickup": r.pickup_text,
                "dropoff": r.dropoff_text,
                "distance_km": round(r.distance_km or 0, 2),
                "price": str(r.price),
                "waze_pickup": f"https://waze.com/ul?ll={r.pickup_lat},{r.pickup_lon}&navigate=yes" if r.pickup_lat and r.pickup_lon else None,
                "waze_dropoff": f"https://waze.com/ul?ll={r.dropoff_lat},{r.dropoff_lon}&navigate=yes" if r.dropoff_lat and r.dropoff_lon else None,
            })
        return {"ok":True,"offers":out,"balance":str(prof.balance),"approved":prof.approved,"online":prof.online}
    finally:
        db.close()

@app.post("/api/driver/accept", response_class=JSONResponse)
def driver_accept(payload: Dict[str,Any]):
    telegram_id = str(payload.get("telegram_id") or "").strip()
    offer_id = payload.get("offer_id")
    if not telegram_id or not offer_id:
        return JSONResponse({"ok":False,"error":"telegram_id, offer_id required"}, status_code=400)

    db = SessionLocal()
    try:
        u = db.query(User).filter(User.telegram_id==telegram_id).first()
        if not u: return JSONResponse({"ok":False,"error":"not registered"}, status_code=400)
        prof = db.query(DriverProfile).filter(DriverProfile.user_id==u.id).first()
        if not prof: return JSONResponse({"ok":False,"error":"profile missing"}, status_code=400)

        if Decimal(str(prof.balance)) <= DRIVER_BLOCK_BALANCE:
            return JSONResponse({"ok":False,"error":"Balans -10 və ya aşağıdır."}, status_code=400)

        offer = db.query(RideOffer).filter(RideOffer.id==int(offer_id), RideOffer.driver_id==prof.id).first()
        if not offer or offer.status != "PENDING":
            return JSONResponse({"ok":False,"error":"Offer not found"}, status_code=404)

        ride = db.query(Ride).filter(Ride.id==offer.ride_id).first()
        if not ride or ride.status in ("ACCEPTED","STARTED","COMPLETED","CANCELED"):
            offer.status = "EXPIRED"; db.commit()
            return JSONResponse({"ok":False,"error":"Ride not available"}, status_code=409)

        # accept: set ride driver + status
        offer.status = "ACCEPTED"
        ride.driver_id = prof.id
        ride.status = "ACCEPTED"
        # expire other offers
        db.query(RideOffer).filter(RideOffer.ride_id==ride.id, RideOffer.id!=offer.id, RideOffer.status=="PENDING").update({"status":"EXPIRED"})
        db.commit()

        return {"ok":True,"ride_id":ride.id}
    finally:
        db.close()

@app.get("/api/rides/{ride_id}/track", response_class=JSONResponse)
def ride_track(ride_id: int):
    db = SessionLocal()
    try:
        ride = db.query(Ride).filter(Ride.id==ride_id).first()
        if not ride or not ride.driver_id:
            return {"ok":False,"status": ride.status if ride else "NOT_FOUND"}
        loc = db.query(DriverLocation).filter(DriverLocation.driver_id==ride.driver_id).first()
        return {
            "ok": True,
            "status": ride.status,
            "driver": {"lat": loc.lat, "lon": loc.lon} if loc else None
        }
    finally:
        db.close()

# ---------------- Admin ----------------

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
        drivers = db.query(DriverProfile).order_by(DriverProfile.id.desc()).limit(50).all()
        rides_data = [{
            "id": r.id,
            "pickup": r.pickup_text,
            "dropoff": r.dropoff_text,
            "status": r.status,
            "price": str(r.price),
            "distance": round(r.distance_km or 0, 2),
            "created_at": str(r.created_at),
        } for r in rides]
        drivers_data = [{
            "id": d.id,
            "name": d.full_name,
            "year": d.car_year,
            "color": d.car_color,
            "approved": d.approved,
            "online": d.online,
            "balance": str(d.balance),
        } for d in drivers]
    finally:
        db.close()

    return templates.TemplateResponse("admin_panel.html", {"request": request, "rides": rides_data, "drivers": drivers_data})

@app.post("/admin/driver/approve")
def admin_driver_approve(request: Request, driver_id: int = Form(...), approved: int = Form(...)):
    if not _is_logged(request):
        return RedirectResponse(url="/admin", status_code=302)
    db = SessionLocal()
    try:
        d = db.query(DriverProfile).filter(DriverProfile.id==driver_id).first()
        if d:
            d.approved = bool(int(approved))
            if not d.approved:
                d.online = False
            db.commit()
    finally:
        db.close()
    return RedirectResponse(url="/admin/panel", status_code=302)

@app.post("/admin/driver/balance")
def admin_driver_balance(request: Request, driver_id: int = Form(...), amount: str = Form(...), note: str = Form("")):
    if not _is_logged(request):
        return RedirectResponse(url="/admin", status_code=302)
    db = SessionLocal()
    try:
        d = db.query(DriverProfile).filter(DriverProfile.id==driver_id).first()
        if d:
            amt = Decimal(str(amount)).quantize(Decimal("0.01"))
            d.balance = Decimal(str(d.balance)) + amt
            db.add(BalanceTxn(driver_id=d.id, kind="adjustment", amount=amt, note=note or "admin"))
            db.commit()
    finally:
        db.close()
    return RedirectResponse(url="/admin/panel", status_code=302)

@app.on_event("startup")
def startup():
    if os.getenv("RUN_BOTS_IN_WEB","0") != "1":
        return
    base_url = (os.getenv("PUBLIC_BASE_URL") or os.getenv("API_BASE") or "").rstrip("/")
    if not base_url:
        return
    apps = build_bot_apps(base_url)
    if not apps:
        return
    group = BotGroup(apps)
    group.start_in_thread()
    app.state.bot_group = group
