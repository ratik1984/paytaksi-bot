import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function Passenger() {
  const [loc, setLoc] = useState(null);
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [dest, setDest] = useState(null);
  const [rides, setRides] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      (p) => setLoc({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => setErr('GPS icazəsi verilmədi: ' + e.message),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (q.trim().length < 3) return setSuggestions([]);
      try {
        const r = await api(`/places/search?q=${encodeURIComponent(q.trim())}`, { auth: false });
        setSuggestions(r.items || []);
      } catch {
        setSuggestions([]);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  async function refreshRides() {
    const r = await api('/rides/me');
    setRides(r.rides || []);
  }

  useEffect(() => {
    refreshRides().catch(() => {});
  }, []);

  async function createRide() {
    setErr('');
    if (!loc) return setErr('GPS lazım...');
    if (!dest) return setErr('Gedəcəyiniz yeri seçin');
    setLoading(true);
    try {
      const r = await api('/rides', {
        method: 'POST',
        body: {
          pickupLat: loc.lat,
          pickupLng: loc.lng,
          pickupText: 'Cari yer',
          dropoffLat: dest.lat,
          dropoffLng: dest.lng,
          dropoffText: dest.display
        }
      });
      await refreshRides();
      setDest(null);
      setQ('');
      setSuggestions([]);
      alert('Sifariş yaradıldı');
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="h1">Sərnişin</div>
        {err && <div className="card">⚠️ {err}</div>}
        <div className="row">
          <div style={{ flex: 1, minWidth: 220 }}>
            <small>Cari yer:</small>
            <div>{loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : 'tapılır…'}</div>
          </div>
          <div style={{ flex: 2, minWidth: 260 }}>
            <small>Gedəcəyiniz yer</small>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Məs: 28 May, Gənclik, Nizami..." />
            {suggestions.length > 0 && (
              <div className="card">
                <small>Alternativ yaxın yerlər:</small>
                {suggestions.map((s, i) => (
                  <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
                    <button
                      onClick={() => {
                        setDest(s);
                        setQ(s.display);
                        setSuggestions([]);
                      }}
                    >
                      {s.display}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {dest && (
              <small>
                Seçildi: <b>{dest.display}</b>
              </small>
            )}
          </div>
        </div>
        <div className="hr" />
        <button className="primary" disabled={loading} onClick={createRide}>
          Sifariş et
        </button>
      </div>

      <div className="card">
        <div className="h1">Mənim sifarişlərim</div>
        <button onClick={refreshRides}>Yenilə</button>
        {rides.length === 0 ? (
          <small>Hələ sifariş yoxdur.</small>
        ) : (
          rides.map((r) => (
            <div className="card" key={r.id}>
              <div className="row">
                <span className="badge">{r.status}</span>
                <span className="badge">{r.fareAzN} AZN</span>
                <span className="badge">{r.distanceKm} km</span>
              </div>
              <small>{new Date(r.createdAt).toLocaleString()}</small>
              <div style={{ marginTop: 8 }}>
                <div><small>Haradan:</small> {r.pickupText || '—'}</div>
                <div><small>Haraya:</small> {r.dropoffText || '—'}</div>
                {r.status === 'REQUESTED' && (
                  <button
                    onClick={async () => {
                      await api(`/rides/${r.id}/cancel`, { method: 'POST' });
                      await refreshRides();
                    }}
                  >
                    Ləğv et
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
