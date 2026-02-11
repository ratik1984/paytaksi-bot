import React, { useEffect, useState } from 'react';
import { api, apiForm } from '../lib/api.js';

const COLORS = ['aq','qara','qirmizi','boz','mavi','sari','yashil'];

export default function Driver() {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ carYear: 2010, carColor: 'qara', carMake: '', carModel: '', carPlate: '' });
  const [loc, setLoc] = useState(null);
  const [nearby, setNearby] = useState([]);
  const [topup, setTopup] = useState({ method: 'CARD_TO_CARD', amountAzN: 10, note: '' });
  const [err, setErr] = useState('');

  async function load() {
    try {
      const r = await api('/driver/me');
      setProfile(r.profile || null);
    } catch (e) {
      setProfile(null);
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      (p) => setLoc({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }, []);

  async function register() {
    setErr('');
    try {
      const r = await api('/driver/register', { method: 'POST', body: { ...form, carYear: Number(form.carYear) } });
      setProfile(r.profile);
      alert('Qeydiyyat tamamlandı');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }

  async function sendLoc() {
    if (!loc) return;
    try {
      await api('/driver/location', { method: 'POST', body: loc });
    } catch {}
  }

  async function refreshNearby() {
    setErr('');
    if (!loc) return setErr('GPS yoxdur');
    try {
      const r = await api(`/driver/nearby-requests?lat=${loc.lat}&lng=${loc.lng}&radiusKm=3`);
      setNearby(r.items || []);
    } catch (e) {
      setErr(String(e.message || e));
    }
  }

  async function uploadDoc(type, file) {
    setErr('');
    const fd = new FormData();
    fd.append('type', type);
    fd.append('file', file);
    try {
      await apiForm('/driver/documents/upload', fd);
      await load();
      alert('Yükləndi');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }

  async function createTopup() {
    setErr('');
    try {
      await api('/topups', { method: 'POST', body: { ...topup, amountAzN: Number(topup.amountAzN) } });
      alert('Top-up sorğusu göndərildi (admin təsdiq edəcək)');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }

  return (
    <div>
      <div className="card">
        <div className="h1">Sürücü</div>
        {err && <div className="card">⚠️ {err}</div>}

        {!profile ? (
          <>
            <small>Qeydiyyat (min. 2010, rəng məhdudiyyətli)</small>
            <div className="row">
              <div style={{ flex: 1, minWidth: 180 }}>
                <small>Buraxılış ili</small>
                <input type="number" value={form.carYear} onChange={(e) => setForm({ ...form, carYear: e.target.value })} />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <small>Rəng</small>
                <select value={form.carColor} onChange={(e) => setForm({ ...form, carColor: e.target.value })}>
                  {COLORS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <small>Marka</small>
                <input value={form.carMake} onChange={(e) => setForm({ ...form, carMake: e.target.value })} placeholder="Toyota" />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <small>Model</small>
                <input value={form.carModel} onChange={(e) => setForm({ ...form, carModel: e.target.value })} placeholder="Prius" />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <small>Nömrə</small>
                <input value={form.carPlate} onChange={(e) => setForm({ ...form, carPlate: e.target.value })} placeholder="10-AA-123" />
              </div>
            </div>
            <button className="primary" onClick={register}>Sürücü kimi qeydiyyat</button>
          </>
        ) : (
          <>
            <div className="row">
              <span className="badge">Balans: {profile.balance} AZN</span>
              <span className="badge">Aktiv: {String(profile.isActive)}</span>
              <span className="badge">Təsdiq: {String(profile.isVerified)}</span>
            </div>
            <small>Avtomobil: {profile.carYear} / {profile.carColor} / {profile.carMake || ''} {profile.carModel || ''} {profile.carPlate || ''}</small>

            <div className="hr" />
            <div className="h1">Sənədlər</div>
            <small>Şəxsiyyət vəsiqəsi, sürücülük vəsiqəsi, texniki pasport — hər biri ön/arxa.</small>

            <DocUploader label="Ş/V ön" type="ID_FRONT" onUpload={uploadDoc} />
            <DocUploader label="Ş/V arxa" type="ID_BACK" onUpload={uploadDoc} />
            <DocUploader label="S/V ön" type="LICENSE_FRONT" onUpload={uploadDoc} />
            <DocUploader label="S/V arxa" type="LICENSE_BACK" onUpload={uploadDoc} />
            <DocUploader label="Tex. pasport ön" type="CAR_REG_FRONT" onUpload={uploadDoc} />
            <DocUploader label="Tex. pasport arxa" type="CAR_REG_BACK" onUpload={uploadDoc} />

            <div className="card">
              <small>Yüklənənlər:</small>
              {(profile.documents || []).map((d) => (
                <div key={d.id}><small>{d.type}</small> — <b>{d.status}</b> {d.note ? `(${d.note})` : ''}</div>
              ))}
            </div>

            <div className="hr" />
            <div className="h1">Balans artır (Kart-to-Kart / M10)</div>
            <div className="row">
              <div style={{ flex: 1, minWidth: 200 }}>
                <small>Metod</small>
                <select value={topup.method} onChange={(e) => setTopup({ ...topup, method: e.target.value })}>
                  <option value="CARD_TO_CARD">Kart-to-Kart</option>
                  <option value="M10">M10</option>
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <small>Məbləğ (AZN)</small>
                <input type="number" value={topup.amountAzN} onChange={(e) => setTopup({ ...topup, amountAzN: e.target.value })} />
              </div>
              <div style={{ flex: 2, minWidth: 240 }}>
                <small>Qeyd (opsional)</small>
                <input value={topup.note} onChange={(e) => setTopup({ ...topup, note: e.target.value })} placeholder="Tranzaksiya ID və s." />
              </div>
            </div>
            <button onClick={createTopup}>Top-up sorğusu göndər</button>

            <div className="hr" />
            <div className="h1">Yaxın sifarişlər</div>
            <small>GPS: {loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : '—'}</small>
            <div className="row">
              <button onClick={async () => { await sendLoc(); await refreshNearby(); }}>Yenilə</button>
            </div>
            {nearby.length === 0 ? (
              <small>Uyğun sifariş yoxdur.</small>
            ) : (
              nearby.map((x) => (
                <div className="card" key={x.ride.id}>
                  <div className="row">
                    <span className="badge">{x.ride.status}</span>
                    <span className="badge">{x.ride.fareAzN} AZN</span>
                    <span className="badge">Pickup: {x.distanceToPickupKm.toFixed(2)} km</span>
                  </div>
                  <div><small>Haraya:</small> {x.ride.dropoffText || '—'}</div>
                  <button className="primary" onClick={async () => {
                    try {
                      await api(`/driver/${x.ride.id}/accept`, { method: 'POST' });
                      alert('Qəbul edildi');
                      await refreshNearby();
                    } catch (e) {
                      setErr(String(e.message || e));
                    }
                  }}>Qəbul et</button>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DocUploader({ label, type, onUpload }) {
  return (
    <div className="row" style={{ alignItems: 'center' }}>
      <div style={{ flex: 1, minWidth: 160 }}><small>{label}</small></div>
      <div style={{ flex: 3, minWidth: 240 }}>
        <input type="file" accept="image/*" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(type, f);
        }} />
      </div>
      <div style={{ flex: 1, minWidth: 120 }}><span className="badge">{type}</span></div>
    </div>
  );
}
