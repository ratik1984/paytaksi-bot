import React, { useEffect, useMemo, useState } from "react";
import "../ui/styles.css";
import { api } from "../lib/api.js";
import { makeSocket } from "../lib/socket.js";

function tg() {
  return window.Telegram?.WebApp;
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("pt_token") || "");
  const [me, setMe] = useState(null);
  const [role, setRole] = useState("passenger");
  const [status, setStatus] = useState("");
  const socket = useMemo(()=> makeSocket(), []);

  useEffect(() => {
    const t = tg();
    if (t) {
      t.ready();
      t.expand();
      t.MainButton?.hide?.();
    }
  }, []);

  useEffect(() => {
    socket.on("connect", () => setStatus("WS connected"));
    socket.on("disconnect", () => setStatus("WS disconnected"));
    socket.on("auth:ok", (p) => setStatus("WS authed"));
    socket.on("trip:offer", (payload) => {
      alert("Yeni sifariş təklifi gəldi! (Driver)\nTrip: " + payload.trip.id);
    });
    return () => socket.disconnect();
  }, [socket]);

  async function login() {
    const t = tg();
    const initData = t?.initData;
    if (!initData) {
      alert("Telegram initData yoxdur. Mini App-i Telegram içində aç.");
      return;
    }
    const res = await api("/auth/telegram", { method: "POST", body: { initData } });
    localStorage.setItem("pt_token", res.token);
    setToken(res.token);
    setMe(res.user);
    setRole(res.user.role);
    socket.emit("auth", { token: res.token });
  }

  async function loadMe() {
    const res = await api("/me", { token });
    setMe(res.user);
    setRole(res.user.role);
    socket.emit("auth", { token });
  }

  useEffect(() => {
    if (token) loadMe().catch(()=>{});
  }, [token]);

  if (!token) {
    return (
      <div className="container">
        <div className="card">
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
            <div>
              <div style={{fontSize:18, fontWeight:800}}>PayTaksi</div>
              <div className="small">Telegram Mini App</div>
            </div>
            <span className="badge">v1</span>
          </div>
          <div className="hr"></div>
          <button className="btn" onClick={login}>Telegram ilə giriş</button>
          <div className="small" style={{marginTop:10}}>
            * Bu səhifə Telegram içində açılmalıdır.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <Header me={me} status={status} />
      <div className="row">
        <button className="btn secondary" onClick={loadMe}>Yenilə</button>
        <button className="btn secondary" onClick={() => { localStorage.removeItem("pt_token"); setToken(""); setMe(null); }}>Çıxış</button>
      </div>
      <div className="hr"></div>

      <RoleTabs role={role} setRole={setRole} />

      {role === "passenger" && <Passenger token={token} />}
      {role === "driver" && <Driver token={token} />}
      {role === "admin" && <AdminShortcut />}

      <div className="card">
        <div style={{fontWeight:800}}>Xəritə</div>
        <div className="small">MVP: xəritə placeholder. Mapbox token versən, UI-ni genişləndirmək rahatdır.</div>
      </div>
    </div>
  );
}

function Header({ me, status }) {
  return (
    <div className="card">
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
        <div>
          <div style={{fontSize:18, fontWeight:800}}>Salam, {me?.name || "İstifadəçi"} 👋</div>
          <div className="small">@{me?.username || "no_username"} • role: {me?.role}</div>
        </div>
        <span className="badge">{status}</span>
      </div>
    </div>
  );
}

function RoleTabs({ role, setRole }) {
  return (
    <div className="card">
      <div style={{fontWeight:800}}>Mod</div>
      <div className="row" style={{marginTop:10}}>
        <button className={"btn " + (role==="passenger" ? "" : "secondary")} onClick={()=>setRole("passenger")}>Sərnişin</button>
        <button className={"btn " + (role==="driver" ? "" : "secondary")} onClick={()=>setRole("driver")}>Sürücü</button>
        <button className={"btn " + (role==="admin" ? "" : "secondary")} onClick={()=>setRole("admin")}>Admin</button>
      </div>
      <div className="small" style={{marginTop:10}}>
        Qeyd: driver olmaq üçün əvvəlcə “Sürücü qeydiyyatı” göndər və admin təsdiqləsin.
      </div>
    </div>
  );
}

function Passenger({ token }) {
  const [pickup, setPickup] = useState({ lat: null, lng: null, address: "" });
  const [drop, setDrop] = useState({ lat: null, lng: null, address: "" });
  const [distance, setDistance] = useState(5); // manual MVP
  const [payment, setPayment] = useState("cash");
  const [createdTrip, setCreatedTrip] = useState(null);

  function getLocation() {
    navigator.geolocation.getCurrentPosition((pos)=>{
      setPickup(p => ({ ...p, lat: pos.coords.latitude, lng: pos.coords.longitude, address: "My location" }));
    }, ()=> alert("Location icazəsi verilmədi."), { enableHighAccuracy: true, timeout: 8000 });
  }

  async function createTrip() {
    if (pickup.lat == null || drop.lat == null) {
      alert("Pickup və Dropoff koordinatları lazımdır (MVP).");
      return;
    }
    const res = await api("/trip/create", {
      method:"POST",
      token,
      body:{
        pickup, dropoff: drop, payment_method: payment, distance_km: Number(distance)
      }
    });
    setCreatedTrip(res.trip);
    alert("Sifariş yaradıldı: " + res.trip.id);
  }

  return (
    <div className="card">
      <div style={{fontWeight:800}}>Sərnişin: Sifariş et</div>
      <div className="small">MVP üçün məsafəni manual verirsən. Places autocomplete xəritə key ilə əlavə olunur.</div>
      <div className="hr"></div>

      <div className="row">
        <button className="btn" onClick={getLocation}>📍 Pickup avtomatik</button>
      </div>

      <div style={{marginTop:10}}>
        <div className="small">Pickup lat/lng</div>
        <input className="input" value={pickup.lat ?? ""} placeholder="lat" onChange={e=>setPickup(p=>({...p, lat: Number(e.target.value)}))} />
        <div style={{height:8}} />
        <input className="input" value={pickup.lng ?? ""} placeholder="lng" onChange={e=>setPickup(p=>({...p, lng: Number(e.target.value)}))} />
      </div>

      <div style={{marginTop:10}}>
        <div className="small">Dropoff lat/lng</div>
        <input className="input" value={drop.lat ?? ""} placeholder="lat" onChange={e=>setDrop(p=>({...p, lat: Number(e.target.value)}))} />
        <div style={{height:8}} />
        <input className="input" value={drop.lng ?? ""} placeholder="lng" onChange={e=>setDrop(p=>({...p, lng: Number(e.target.value)}))} />
      </div>

      <div style={{marginTop:10}}>
        <div className="small">Məsafə (km) — MVP</div>
        <input className="input" value={distance} onChange={e=>setDistance(e.target.value)} />
      </div>

      <div style={{marginTop:10}}>
        <div className="small">Ödəniş</div>
        <div className="row" style={{marginTop:8}}>
          <button className={"btn "+(payment==="cash"?"":"secondary")} onClick={()=>setPayment("cash")}>Nağd</button>
          <button className={"btn "+(payment==="card"?"":"secondary")} onClick={()=>setPayment("card")}>Kart</button>
        </div>
      </div>

      <div className="hr"></div>
      <button className="btn" onClick={createTrip}>🚕 Sifarişi təsdiqlə</button>

      {createdTrip && (
        <div style={{marginTop:12}} className="small">
          Trip status: <b>{createdTrip.status}</b> • ID: {createdTrip.id}
        </div>
      )}
    </div>
  );
}

function Driver({ token }) {
  const [carMake, setCarMake] = useState("Toyota");
  const [carModel, setCarModel] = useState("Prius");
  const [plate, setPlate] = useState("10-AA-000");
  const [lat, setLat] = useState(40.4093);
  const [lng, setLng] = useState(49.8671);

  async function apply() {
    await api("/driver/apply", { method:"POST", token, body:{ car_make: carMake, car_model: carModel, plate } });
    alert("Sürücü müraciəti göndərildi (pending). Admin təsdiqləməlidir.");
  }

  async function online() {
    await api("/driver/online", { method:"POST", token });
    alert("Online oldun.");
  }

  async function offline() {
    await api("/driver/offline", { method:"POST", token });
    alert("Offline oldun.");
  }

  async function sendLoc() {
    await api("/driver/location", { method:"POST", token, body:{ lat:Number(lat), lng:Number(lng) } });
  }

  function autoLoc() {
    navigator.geolocation.getCurrentPosition((pos)=>{
      setLat(pos.coords.latitude);
      setLng(pos.coords.longitude);
    }, ()=> alert("Location icazəsi verilmədi."), { enableHighAccuracy: true, timeout: 8000 });
  }

  return (
    <div className="card">
      <div style={{fontWeight:800}}>Sürücü paneli</div>
      <div className="small">1) Apply → 2) Admin approve → 3) Online → 4) Location göndər.</div>
      <div className="hr"></div>

      <div className="small">Avto məlumatı</div>
      <input className="input" value={carMake} onChange={e=>setCarMake(e.target.value)} placeholder="car make" />
      <div style={{height:8}} />
      <input className="input" value={carModel} onChange={e=>setCarModel(e.target.value)} placeholder="car model" />
      <div style={{height:8}} />
      <input className="input" value={plate} onChange={e=>setPlate(e.target.value)} placeholder="plate" />

      <div className="row" style={{marginTop:10}}>
        <button className="btn" onClick={apply}>📝 Sürücü qeydiyyatı</button>
        <button className="btn secondary" onClick={online}>✅ Online</button>
        <button className="btn secondary" onClick={offline}>⛔ Offline</button>
      </div>

      <div className="hr"></div>

      <div className="small">Lokasiya</div>
      <div className="row" style={{marginTop:8}}>
        <button className="btn" onClick={autoLoc}>📍 Avtomatik</button>
        <button className="btn secondary" onClick={sendLoc}>📡 Göndər</button>
      </div>
      <div style={{height:8}} />
      <input className="input" value={lat} onChange={e=>setLat(e.target.value)} />
      <div style={{height:8}} />
      <input className="input" value={lng} onChange={e=>setLng(e.target.value)} />
    </div>
  );
}

function AdminShortcut() {
  return (
    <div className="card">
      <div style={{fontWeight:800}}>Admin</div>
      <div className="small">Admin panel ayrıca URL-dədir: / Admin build ayrı app.</div>
    </div>
  );
}
