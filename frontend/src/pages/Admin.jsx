import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

const BASE = import.meta.env.VITE_API_BASE || "";

export default function Admin() {
  const [token, setToken] = useState(localStorage.getItem("pt_admin_token") || "");
  const [login, setLogin] = useState("Ratik");
  const [password, setPassword] = useState("0123456789");
  const [msg, setMsg] = useState("");

  const [drivers, setDrivers] = useState([]);
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [settings, setSettings] = useState([]);

  async function doLogin() {
    setMsg("");
    try {
      const r = await api("/admin/login", { method:"POST", body: { login, password } });
      localStorage.setItem("pt_admin_token", r.token);
      setToken(r.token);
    } catch {
      setMsg("Login səhvdir.");
    }
  }

  async function loadDrivers() {
    const r = await api(`/admin/drivers?status=${statusFilter}`, { token });
    setDrivers(r.drivers || []);
  }

  async function loadSettings() {
    const r = await api("/admin/settings", { token });
    setSettings(r.settings || []);
  }

  useEffect(() => {
    if (token) { loadDrivers().catch(()=>{}); loadSettings().catch(()=>{}); }
  }, [token, statusFilter]);

  async function setDriverStatus(userId, status) {
    await api("/admin/drivers/status", { method:"POST", token, body: { userId, status } });
    await loadDrivers();
  }

  function sVal(key, def="") {
    return (settings.find(s=>s.key===key)?.value) ?? def;
  }

  const [form, setForm] = useState({
    commissionRate: 0.10, startFare: 3.5, freeKm: 3.0, perKmAfter: 0.40, driverMinBalance: -10, driverMinYear: 2010
  });

  useEffect(() => {
    if (!settings.length) return;
    setForm({
      commissionRate: Number(sVal("commissionRate","0.1")),
      startFare: Number(sVal("startFare","3.5")),
      freeKm: Number(sVal("freeKm","3")),
      perKmAfter: Number(sVal("perKmAfter","0.4")),
      driverMinBalance: Number(sVal("driverMinBalance","-10")),
      driverMinYear: Number(sVal("driverMinYear","2010"))
    });
  }, [settings.length]);

  async function saveSettings() {
    await api("/admin/settings", { method:"POST", token, body: {
      commissionRate: Number(form.commissionRate),
      startFare: Number(form.startFare),
      freeKm: Number(form.freeKm),
      perKmAfter: Number(form.perKmAfter),
      driverMinBalance: Number(form.driverMinBalance),
      driverMinYear: Number(form.driverMinYear)
    }});
    await loadSettings();
    setMsg("Setting-lər yadda saxlandı.");
  }

  if (!token) {
    return (
      <div className="card">
        <div className="h1">Admin giriş</div>
        <div className="row">
          <div className="col">
            <label className="muted">Login</label>
            <input value={login} onChange={(e)=>setLogin(e.target.value)} />
          </div>
          <div className="col">
            <label className="muted">Parol</label>
            <input type="password" value={password} onChange={(e)=>setPassword(e.target.value)} />
          </div>
        </div>
        <button onClick={doLogin}>Daxil ol</button>
        {msg && <div className="muted" style={{marginTop:10}}>{msg}</div>}
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="h1">Admin panel</div>
        <div className="row">
          <div className="col">
            <label className="muted">Sürücü status filter</label>
            <select value={statusFilter} onChange={(e)=>setStatusFilter(e.target.value)}>
              <option value="PENDING">PENDING</option>
              <option value="APPROVED">APPROVED</option>
              <option value="REJECTED">REJECTED</option>
            </select>
          </div>
          <div className="col">
            <button onClick={()=>{localStorage.removeItem("pt_admin_token"); setToken("");}}>Çıxış</button>
          </div>
        </div>
        {msg && <div className="muted" style={{marginTop:10}}>{msg}</div>}
      </div>

      <div className="card">
        <div className="h1">Sürücülər ({drivers.length})</div>
        {drivers.length === 0 ? <div className="muted">Boşdur.</div> : (
          <div className="list">
            {drivers.map(d => (
              <div key={d.id} className="item">
                <b>{d.user?.name || d.user?.username || d.userId}</b>
                <div className="muted">İl: {d.carYear} • rəng: {d.carColor} • balans: {Number(d.balance||0).toFixed(2)}</div>
                <div className="muted">Docs: {d.documents?.length || 0}</div>
                {d.documents?.length ? (
                  <div className="muted" style={{marginTop:6}}>
                    {d.documents.map(doc => (
                      <a key={doc.id} href={BASE + doc.path} target="_blank" rel="noreferrer" className="badge">
                        {doc.type}
                      </a>
                    ))}
                  </div>
                ) : null}
                <div className="row" style={{marginTop:10}}>
                  <div className="col"><button onClick={()=>setDriverStatus(d.userId,"APPROVED")}>Approve</button></div>
                  <div className="col"><button onClick={()=>setDriverStatus(d.userId,"REJECTED")} style={{background:"linear-gradient(180deg,#8b3b3b,#5c1a1a)"}}>Reject</button></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="h1">Setting-lər</div>
        <div className="row">
          <div className="col">
            <label className="muted">Komissiya (0.10)</label>
            <input type="number" step="0.01" value={form.commissionRate} onChange={(e)=>setForm(f=>({...f, commissionRate: e.target.value}))} />
          </div>
          <div className="col">
            <label className="muted">Start (AZN)</label>
            <input type="number" step="0.01" value={form.startFare} onChange={(e)=>setForm(f=>({...f, startFare: e.target.value}))} />
          </div>
        </div>
        <div className="row">
          <div className="col">
            <label className="muted">3 km limit</label>
            <input type="number" step="0.1" value={form.freeKm} onChange={(e)=>setForm(f=>({...f, freeKm: e.target.value}))} />
          </div>
          <div className="col">
            <label className="muted">Sonra AZN/km</label>
            <input type="number" step="0.01" value={form.perKmAfter} onChange={(e)=>setForm(f=>({...f, perKmAfter: e.target.value}))} />
          </div>
        </div>
        <div className="row">
          <div className="col">
            <label className="muted">Min balans</label>
            <input type="number" step="0.01" value={form.driverMinBalance} onChange={(e)=>setForm(f=>({...f, driverMinBalance: e.target.value}))} />
          </div>
          <div className="col">
            <label className="muted">Min il</label>
            <input type="number" value={form.driverMinYear} onChange={(e)=>setForm(f=>({...f, driverMinYear: e.target.value}))} />
          </div>
        </div>
        <button onClick={saveSettings}>Yadda saxla</button>
      </div>
    </>
  );
}
