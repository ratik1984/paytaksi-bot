import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";

import { api, getToken, setToken } from "../lib/api.js";
import { getTgUser } from "../lib/telegram.js";
import { getSocket } from "../lib/socket.js";

L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });

function useDebounced(value, ms=500) {
  const [v, setV] = useState(value);
  useEffect(() => {
  if (!token || !me?.id) return;

  const sock = getSocket();
  socketRef.current = sock;

  const doJoin = () => {
    try { sock.emit("join", { role: "PASSENGER", userId: me.id }); } catch {}
  };

  sock.on("connect", doJoin);
  if (sock.connected) doJoin();

  sock.on("ride_update", (p) => {
    if (p?.ride) { setRide(p.ride); setStatus(p.status); }
  });

  return () => {
    try {
      sock.off("connect", doJoin);
      sock.off("ride_update");
    } catch {}
  };
}, [token, me?.id]);
// get gps
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async (p) => {
      const lat = p.coords.latitude;
      const lng = p.coords.longitude;
      setPos({ lat, lng });
      // reverse
      try {
        const rev = await api(`/geo/reverse?lat=${lat}&lng=${lng}`);
        const name = rev?.features?.[0]?.properties?.name
          || rev?.features?.[0]?.properties?.street
          || rev?.features?.[0]?.properties?.city
          || rev?.features?.[0]?.properties?.country
          || "Cari yer";
        const full = rev?.features?.[0]?.properties?.name
          ? rev.features[0].properties.name
          : (rev?.features?.[0]?.properties?.street || "Cari yer");
        setPosName(rev?.features?.[0]?.properties?.name || rev?.features?.[0]?.properties?.street || rev?.features?.[0]?.properties?.city || "Cari yer");
      } catch {
        setPosName(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      }
    }, () => {}, { enableHighAccuracy: true, timeout: 10000 });
  }, []);

  // search suggestions
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!deb || deb.length < 3) { setSuggest([]); return; }
      try {
        const lat = pos?.lat;
        const lng = pos?.lng;
        const s = await api(`/geo/search?q=${encodeURIComponent(deb)}${lat && lng ? `&lat=${lat}&lng=${lng}` : ""}`);
        const features = (s?.features || []).map(f => ({
          label: f.properties?.name || f.properties?.street || f.properties?.city || "Yer",
          city: f.properties?.city || "",
          country: f.properties?.country || "",
          lat: f.geometry?.coordinates?.[1],
          lng: f.geometry?.coordinates?.[0]
        })).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng));
        if (!stop) setSuggest(features);
      } catch {
        if (!stop) setSuggest([]);
      }
    })();
    return () => { stop = true; };
  }, [deb, pos?.lat, pos?.lng]);

  async function createRide() {
    if (!pos || !drop) return;
    const r = await api("/rides/create", {
      method: "POST",
      token,
      body: {
        pickupLat: pos.lat,
        pickupLng: pos.lng,
        pickupText: posName || "Cari yer",
        dropLat: drop.lat,
        dropLng: drop.lng,
        dropText: drop.label || ""
      }
    });
    setRide(r.ride);
    setStatus(r.ride.status);
  }

  return (
    <>
      <div className="card">
        <div className="h1">Sərnişin</div>
        <div className="muted">Cari yer: <b style={{color:"var(--text)"}}>{posName || "..."}</b></div>
      </div>

      <div className="card">
        <div className="row">
          <div className="col">
            <label className="muted">Gedəcəyiniz yer</label>
            <input value={dropText} onChange={(e)=>setDropText(e.target.value)} placeholder="Məs: Nizami m., 28 May, Bakı..." />
            {suggest.length > 0 && (
              <div className="list" style={{marginTop:8}}>
                {suggest.map((s, i) => (
                  <div key={i} className="item" onClick={()=>{
                    setDrop({ lat: s.lat, lng: s.lng, label: s.label });
                    setDropText(`${s.label}${s.city?`, ${s.city}`:""}`);
                    setSuggest([]);
                  }} style={{cursor:"pointer"}}>
                    <b>{s.label}</b> <small>{[s.city, s.country].filter(Boolean).join(", ")}</small>
                  </div>
                ))}
              </div>
            )}
            <div style={{height:10}} />
            <button onClick={createRide} disabled={!pos || !drop || !token}>Sifariş yarat</button>
          </div>
          <div className="col">
            <div className="mapWrap">
              <MapContainer center={pos ? [pos.lat, pos.lng] : [40.4093, 49.8671]} zoom={13} style={{height:"100%", width:"100%"}}>
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution="&copy; OpenStreetMap contributors"
                />
                {pos && <Marker position={[pos.lat, pos.lng]}><Popup>Cari yer</Popup></Marker>}
                {drop && <Marker position={[drop.lat, drop.lng]}><Popup>Gediləcək yer</Popup></Marker>}
                {poly && <Polyline positions={poly} />}
              </MapContainer>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="h1">Sifariş statusu</div>
        {ride ? (
          <>
            <div className="row">
              <div className="col">
                <span className="badge ok">#{ride.id.slice(0,6)}</span>
                <span className="badge">{status}</span>
              </div>
              <div className="col">
                <div className="muted">Məsafə: <b style={{color:"var(--text)"}}>{(ride.distanceKm||0).toFixed(2)} km</b></div>
                <div className="muted">Qiymət: <b style={{color:"var(--text)"}}>{(ride.fareAzN||0).toFixed(2)} AZN</b></div>
              </div>
            </div>
            <hr />
            <div className="muted">Götürmə: {ride.pickupText || "-"}</div>
            <div className="muted">Çatdırılma: {ride.dropText || "-"}</div>
          </>
        ) : (
          <div className="muted">Hələ sifariş yoxdur.</div>
        )}
      </div>
    </>
  );
}
