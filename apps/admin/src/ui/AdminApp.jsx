import React, { useEffect, useState } from "react";
import { api } from "./api.js";

export default function AdminApp() {
  const [token, setToken] = useState(localStorage.getItem("pt_admin_token") || "");
  const [stats, setStats] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [trips, setTrips] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (token) refresh().catch(e=>setError(String(e.message||e)));
  }, [token]);

  async function refresh() {
    setError("");
    const s = await api("/admin/stats", { token });
    setStats(s);
    const d = await api("/admin/drivers", { token });
    setDrivers(d.drivers || []);
    const t = await api("/admin/trips", { token });
    setTrips(t.trips || []);
  }

  async function approve(id) {
    await api("/admin/driver/approve", { method:"POST", token, body:{ driver_user_id: id } });
    await refresh();
  }

  async function reject(id) {
    await api("/admin/driver/reject", { method:"POST", token, body:{ driver_user_id: id } });
    await refresh();
  }

  if (!token) {
    return (
      <div className="container">
        <div className="card">
          <div style={{fontSize:18, fontWeight:900}}>PayTaksi Admin</div>
          <div className="small">Burada JWT token yazmalısan (admin login /auth/telegram ilə alınır).</div>
          <div style={{height:10}} />
          <input className="input" placeholder="Admin JWT token" onChange={(e)=>setToken(e.target.value)} />
          <div style={{height:10}} />
          <button className="btn" onClick={()=>{ localStorage.setItem("pt_admin_token", token); }}>Yadda saxla</button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <div className="row" style={{justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:18, fontWeight:900}}>PayTaksi Admin Panel</div>
            <div className="small">ADMIN_TG_ID=1326729201 olan Telegram hesabı ilə giriş edin.</div>
          </div>
          <div className="row">
            <button className="btn secondary" onClick={refresh}>Yenilə</button>
            <button className="btn secondary" onClick={()=>{ localStorage.removeItem("pt_admin_token"); setToken(""); }}>Çıxış</button>
          </div>
        </div>
        {error && <div className="small" style={{marginTop:8, color:"#ff8a8a"}}>{error}</div>}
      </div>

      {stats && (
        <div className="row">
          <Stat title="İstifadəçi" value={stats.users} />
          <Stat title="Sifariş" value={stats.trips} />
          <Stat title="Online sürücü" value={stats.onlineDrivers} />
        </div>
      )}

      <div className="card">
        <div style={{fontWeight:900}}>Sürücülər</div>
        <div className="small">Pending sürücüləri approve edin.</div>
        <div style={{height:10}} />
        <table className="table">
          <thead>
            <tr>
              <th>Ad</th><th>Status</th><th>Maşın</th><th>Plate</th><th>Rating</th><th>Online</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map(d => (
              <tr key={d.id}>
                <td>{d.name} <span className="small">@{d.username||""}</span></td>
                <td><span className="badge">{d.status}</span></td>
                <td>{d.car_make} {d.car_model}</td>
                <td>{d.plate}</td>
                <td>{d.rating}</td>
                <td>{d.is_online ? "✅" : "—"}</td>
                <td className="row">
                  <button className="btn" onClick={()=>approve(d.id)}>Approve</button>
                  <button className="btn secondary" onClick={()=>reject(d.id)}>Reject</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div style={{fontWeight:900}}>Son Trips</div>
        <div style={{height:10}} />
        <table className="table">
          <thead>
            <tr>
              <th>ID</th><th>Status</th><th>Sərnişin</th><th>Sürücü</th><th>KM</th><th>Fare</th><th>Pay</th><th>Created</th>
            </tr>
          </thead>
          <tbody>
            {trips.map(t => (
              <tr key={t.id}>
                <td className="small">{t.id}</td>
                <td><span className="badge">{t.status}</span></td>
                <td>{t.passenger_name}</td>
                <td>{t.driver_name || "—"}</td>
                <td>{t.distance_km ?? "—"}</td>
                <td>{t.fare_final ?? t.fare_estimated ?? "—"}</td>
                <td>{t.payment_method}/{t.payment_status}</td>
                <td className="small">{new Date(t.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div style={{fontWeight:900}}>Qeyd</div>
        <div className="small">
          Admin token almaq üçün: Telegram Mini App-də admin hesabı ilə login edin, browser console-da localStorage-dan `pt_token` götürün və bura yazın.
          (İstehsalda ayrıca admin login ekranı da əlavə oluna bilər.)
        </div>
      </div>
    </div>
  );
}

function Stat({ title, value }) {
  return (
    <div className="card" style={{minWidth:220}}>
      <div className="small">{title}</div>
      <div style={{fontSize:26, fontWeight:900}}>{value}</div>
    </div>
  );
}
