import React, { useEffect, useRef, useState } from "react";
import { api, getToken, setToken } from "../lib/api.js";
import { getTgUser } from "../lib/telegram.js";
import { getSocket } from "../lib/socket.js";

export default function Driver() {
  const [token, setTokState] = useState(getToken());
  const [me, setMe] = useState(null);
  const [profile, setProfile] = useState(null);
  const [msg, setMsg] = useState("");
  const [offer, setOffer] = useState(null);
  const [ride, setRide] = useState(null);

  const [carYear, setCarYear] = useState(2015);
  const [carColor, setCarColor] = useState("qara");
  const [carModel, setCarModel] = useState("");
  const [carPlate, setCarPlate] = useState("");

  const [files, setFiles] = useState({});
  const [online, setOnline] = useState(false);
  const timerRef = useRef(null);
  const socketRef = useRef(null);

  async function ensureLogin() {
    const tg = getTgUser() || { id: "demo_driver", first_name: "Demo", last_name: "Driver", username: "demo_driver" };
    const r = await api("/auth/telegram", { method:"POST", body: { user: tg, role: "DRIVER" } });
    setToken(r.token);
    setTokState(r.token);
    setMe(r.user);
  }

  async function refresh() {
    const r = await api("/driver/me", { token });
    setProfile(r.user?.driverProfile || null);
  }

  useEffect(() => {
  if (!token || !me?.id) return;

  const sock = getSocket();
  socketRef.current = sock;

  const doJoin = () => {
    try { sock.emit("join", { role: "DRIVER", userId: me.id }); } catch {}
  };

  // Join on first connect and every reconnect (rooms reset on reconnect)
  sock.on("connect", doJoin);
  if (sock.connected) doJoin();

  sock.on("ride_offer", (p) => setOffer(p));
  sock.on("ride_update", (p) => { if (p?.ride) setRide(p.ride); });

  return () => {
    try {
      sock.off("connect", doJoin);
      sock.off("ride_offer");
      sock.off("ride_update");
    } catch {}
  };
}, [token, me?.id]);
async function register() {
    setMsg("");
    try {
      await api("/driver/register", { method:"POST", token, body: { carYear: Number(carYear), carColor, carModel, carPlate } });
      await refresh();
      setMsg("Qeydiyyat uğurlu. İndi sənədləri yüklə.");
    } catch (e) {
      setMsg(e?.data?.error ? String(e.data.error) : "Xəta");
    }
  }

  async function uploadDocs() {
    setMsg("");
    const fd = new FormData();
    ["id_front","id_back","dl_front","dl_back","tp_front","tp_back"].forEach(k => {
      if (files[k]) fd.append(k, files[k]);
    });
    try {
      await api("/driver/documents", { method:"POST", token, body: fd });
      await refresh();
      setMsg("Sənədlər yükləndi. Admin təsdiqi gözlənilir.");
    } catch {
      setMsg("Sənəd yükləmədə xəta.");
    }
  }

  async function sendLocationOnce() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async (p) => {
      const lat = p.coords.latitude;
      const lng = p.coords.longitude;
      try {
        await api("/driver/location", { method:"POST", token, body: { lat, lng, heading: p.coords.heading || undefined, speed: p.coords.speed || undefined } });
      } catch {}
    }, ()=>{}, { enableHighAccuracy: true, timeout: 8000 });
  }

  function toggleOnline() {
    if (!online) {
      setOnline(true);
      sendLocationOnce();
      timerRef.current = setInterval(sendLocationOnce, 5000);
    } else {
      setOnline(false);
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  async function acceptRide() {
    if (!offer?.rideId) return;
    try {
      const r = await api("/rides/accept", { method:"POST", token, body: { rideId: offer.rideId } });
      setRide(r.ride);
      setOffer(null);
      setMsg("Sifariş qəbul edildi.");
    } catch (e) {
      setMsg(e?.data?.error || "Qəbul etmə xətası");
    }
  }

  async function setRideStatus(status) {
    if (!ride?.id) return;
    const r = await api("/rides/status", { method:"POST", token, body: { rideId: ride.id, status } });
    setRide(r.ride);
  }

  const approved = profile?.status === "APPROVED";

  return (
    <>
      <div className="card">
        <div className="h1">Sürücü</div>
        {profile ? (
          <div className="row">
            <div className="col">
              <span className={"badge " + (profile.status==="APPROVED"?"ok":profile.status==="PENDING"?"warn":"danger")}>
                Status: {profile.status}
              </span>
              <span className="badge">Balans: {Number(profile.balance||0).toFixed(2)} AZN</span>
            </div>
            <div className="col">
              <button onClick={toggleOnline} disabled={!approved}>
                {online ? "Offline ol" : "Online ol"}
              </button>
              {!approved && <div className="muted" style={{marginTop:6}}>Online olmaq üçün admin təsdiqi lazımdır.</div>}
            </div>
          </div>
        ) : (
          <div className="muted">Qeydiyyat edilməyib.</div>
        )}
        {msg && <div className="muted" style={{marginTop:10}}>{msg}</div>}
      </div>

      <div className="card">
        <div className="h1">Qeydiyyat</div>
        <div className="row">
          <div className="col">
            <label className="muted">Avtomobil ili (min 2010)</label>
            <input type="number" value={carYear} onChange={(e)=>setCarYear(e.target.value)} />
          </div>
          <div className="col">
            <label className="muted">Rəng</label>
            <select value={carColor} onChange={(e)=>setCarColor(e.target.value)}>
              {["aq","qara","qirmizi","boz","mavi","sari","yashil"].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="row">
          <div className="col">
            <label className="muted">Model</label>
            <input value={carModel} onChange={(e)=>setCarModel(e.target.value)} placeholder="məs: Prius" />
          </div>
          <div className="col">
            <label className="muted">Nömrə</label>
            <input value={carPlate} onChange={(e)=>setCarPlate(e.target.value)} placeholder="məs: 10-AB-123" />
          </div>
        </div>
        <button onClick={register} disabled={!token}>Qeydiyyatı tamamla</button>
      </div>

      <div className="card">
        <div className="h1">Sənədlər</div>
        <div className="row">
          <div className="col">
            <label className="muted">Şəxsiyyət (ön)</label>
            <input type="file" accept="image/*" onChange={(e)=>setFiles(f=>({...f, id_front: e.target.files?.[0]}))} />
          </div>
          <div className="col">
            <label className="muted">Şəxsiyyət (arxa)</label>
            <input type="file" accept="image/*" onChange={(e)=>setFiles(f=>({...f, id_back: e.target.files?.[0]}))} />
          </div>
        </div>
        <div className="row">
          <div className="col">
            <label className="muted">Sürücülük (ön)</label>
            <input type="file" accept="image/*" onChange={(e)=>setFiles(f=>({...f, dl_front: e.target.files?.[0]}))} />
          </div>
          <div className="col">
            <label className="muted">Sürücülük (arxa)</label>
            <input type="file" accept="image/*" onChange={(e)=>setFiles(f=>({...f, dl_back: e.target.files?.[0]}))} />
          </div>
        </div>
        <div className="row">
          <div className="col">
            <label className="muted">Texniki pasport (ön)</label>
            <input type="file" accept="image/*" onChange={(e)=>setFiles(f=>({...f, tp_front: e.target.files?.[0]}))} />
          </div>
          <div className="col">
            <label className="muted">Texniki pasport (arxa)</label>
            <input type="file" accept="image/*" onChange={(e)=>setFiles(f=>({...f, tp_back: e.target.files?.[0]}))} />
          </div>
        </div>
        <button onClick={uploadDocs} disabled={!token}>Sənədləri yüklə</button>
        {profile?.documents?.length ? <div className="muted" style={{marginTop:8}}>Yüklənmiş fayl sayı: {profile.documents.length}</div> : null}
      </div>

      <div className="card">
        <div className="h1">Sifarişlər</div>
        {offer ? (
          <div className="item">
            <b>Yeni sifariş təklifi</b>
            <div className="muted">Ride: {offer.rideId.slice(0,6)} • məsafə: {offer.distanceKm.toFixed(2)} km</div>
            <div style={{height:8}} />
            <button onClick={acceptRide}>Qəbul et</button>
          </div>
        ) : (
          <div className="muted">Təklif yoxdur.</div>
        )}

        {ride && (
          <>
            <hr />
            <div className="item">
              <b>Aktiv ride: {ride.id.slice(0,6)}</b>
              <div className="muted">Status: {ride.status}</div>
              <div className="muted">Qiymət: {(ride.fareAzN||0).toFixed(2)} AZN</div>
              <div style={{height:10}} />
              <div className="row">
                <div className="col"><button onClick={()=>setRideStatus("ARRIVED")} disabled={ride.status!=="ACCEPTED"}>Çatdım</button></div>
                <div className="col"><button onClick={()=>setRideStatus("IN_RIDE")} disabled={ride.status!=="ARRIVED"}>Yoldayıq</button></div>
                <div className="col"><button onClick={()=>setRideStatus("COMPLETED")} disabled={ride.status!=="IN_RIDE"}>Bitdi</button></div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
