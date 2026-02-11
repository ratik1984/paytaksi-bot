import React, { useEffect, useState } from 'react';
import { api, API_BASE } from '../lib/api.js';

export default function Admin() {
  const [dash, setDash] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [topups, setTopups] = useState([]);
  const [settings, setSettings] = useState({});
  const [err, setErr] = useState('');

  async function loadAll() {
    setErr('');
    try {
      const d = await api('/admin/dashboard');
      setDash(d);
      setSettings(d.pricing ? {
        COMMISSION_RATE: String(d.pricing.commissionRate),
        BASE_FARE_AZN: String(d.pricing.base),
        INCLUDED_KM: String(d.pricing.includedKm),
        PER_KM_AZN: String(d.pricing.perKm),
        DRIVER_BLOCK_BALANCE: String(d.pricing.blockBal),
        MIN_CAR_YEAR: String(d.pricing.minCarYear),
        ALLOWED_CAR_COLORS: d.pricing.allowedColors?.join(',')
      } : {});

      const dr = await api('/admin/drivers');
      setDrivers(dr.items || []);

      const tp = await api('/admin/topups');
      setTopups(tp.items || []);
    } catch (e) {
      setErr(String(e.message || e));
    }
  }

  useEffect(() => { loadAll(); }, []);

  async function saveSettings() {
    try {
      await api('/admin/settings', { method: 'POST', body: settings });
      alert('Saxlandı');
      await loadAll();
    } catch (e) {
      setErr(String(e.message || e));
    }
  }

  return (
    <div>
      <div className="card">
        <div className="h1">Admin Panel</div>
        {err && <div className="card">⚠️ {err}</div>}
        {!dash ? <small>Yüklənir…</small> : (
          <div className="row">
            <span className="badge">Users: {dash.users}</span>
            <span className="badge">Drivers: {dash.drivers}</span>
            <span className="badge">Rides: {dash.rides}</span>
            <span className="badge">Topups: {dash.topups}</span>
          </div>
        )}
        <button onClick={loadAll}>Yenilə</button>
      </div>

      <div className="card">
        <div className="h1">Settings</div>
        <small>Komissiya, qiymətlər, min il və rənglər buradan dəyişir.</small>
        <div className="row">
          <Field label="Komissiya (0.10)" value={settings.COMMISSION_RATE} onChange={(v)=>setSettings({...settings, COMMISSION_RATE:v})} />
          <Field label="Start fare" value={settings.BASE_FARE_AZN} onChange={(v)=>setSettings({...settings, BASE_FARE_AZN:v})} />
          <Field label="Included km" value={settings.INCLUDED_KM} onChange={(v)=>setSettings({...settings, INCLUDED_KM:v})} />
          <Field label="Per km" value={settings.PER_KM_AZN} onChange={(v)=>setSettings({...settings, PER_KM_AZN:v})} />
          <Field label="Driver block balance" value={settings.DRIVER_BLOCK_BALANCE} onChange={(v)=>setSettings({...settings, DRIVER_BLOCK_BALANCE:v})} />
          <Field label="Min car year" value={settings.MIN_CAR_YEAR} onChange={(v)=>setSettings({...settings, MIN_CAR_YEAR:v})} />
          <Field label="Allowed colors (csv)" value={settings.ALLOWED_CAR_COLORS} onChange={(v)=>setSettings({...settings, ALLOWED_CAR_COLORS:v})} />
        </div>
        <button className="primary" onClick={saveSettings}>Saxla</button>
      </div>

      <div className="card">
        <div className="h1">Sürücülər</div>
        {drivers.length === 0 ? <small>—</small> : drivers.map((d) => (
          <div className="card" key={d.id}>
            <div className="row">
              <span className="badge">{d.user?.name || 'Driver'}</span>
              <span className="badge">{d.carYear} / {d.carColor}</span>
              <span className="badge">Balans: {d.balance} AZN</span>
              <span className="badge">Verified: {String(d.isVerified)}</span>
              <span className="badge">Active: {String(d.isActive)}</span>
            </div>
            <div className="row">
              <button onClick={async () => {
                await api(`/admin/drivers/${d.id}/verify`, { method: 'POST', body: { isVerified: !d.isVerified, isActive: d.isActive } });
                await loadAll();
              }}>{d.isVerified ? 'Verify ləğv' : 'Verify et'}</button>
              <button onClick={async () => {
                await api(`/admin/drivers/${d.id}/verify`, { method: 'POST', body: { isVerified: d.isVerified, isActive: !d.isActive } });
                await loadAll();
              }}>{d.isActive ? 'Deaktiv et' : 'Aktiv et'}</button>
            </div>

            <div className="hr" />
            <small>Sənədlər:</small>
            {(d.documents || []).map((doc) => (
              <div key={doc.id} className="card">
                <div className="row">
                  <span className="badge">{doc.type}</span>
                  <span className="badge">{doc.status}</span>
                </div>
                <a href={`${API_BASE}/${doc.filePath}`} target="_blank" rel="noreferrer">Faylı aç</a>
                <div className="row">
                  <button onClick={async () => {
                    await api(`/admin/documents/${doc.id}/status`, { method: 'POST', body: { status: 'APPROVED' } });
                    await loadAll();
                  }}>Approve</button>
                  <button onClick={async () => {
                    await api(`/admin/documents/${doc.id}/status`, { method: 'POST', body: { status: 'REJECTED', note: 'Yenidən yükləyin' } });
                    await loadAll();
                  }}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="h1">Top-up sorğuları</div>
        {topups.length === 0 ? <small>—</small> : topups.map((t) => (
          <div className="card" key={t.id}>
            <div className="row">
              <span className="badge">{t.status}</span>
              <span className="badge">{t.method}</span>
              <span className="badge">{t.amountAzN} AZN</span>
              <span className="badge">{t.user?.name || t.userId}</span>
            </div>
            <small>{t.note || ''}</small>
            {t.status === 'PENDING' && (
              <div className="row">
                <button className="primary" onClick={async () => { await api(`/admin/topups/${t.id}/decision`, { method: 'POST', body: { status: 'APPROVED' } }); await loadAll(); }}>Approve</button>
                <button onClick={async () => { await api(`/admin/topups/${t.id}/decision`, { method: 'POST', body: { status: 'REJECTED', adminNote: 'Uyğun deyil' } }); await loadAll(); }}>Reject</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, value, onChange }) {
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <small>{label}</small>
      <input value={value || ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
