import React, { useState } from 'react';
import { api } from '../lib/api.js';

export default function AdminLogin({ onAuthed }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  async function login() {
    setErr('');
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
      onAuthed?.(r.user, r.token);
      alert('Admin giriş uğurlu');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }

  return (
    <div className="card">
      <div className="h1">Admin Login</div>
      {err && <div className="card">⚠️ {err}</div>}
      <small>ADMIN_LOGIN və ADMIN_PASSWORD backend env-də qurulmalıdır.</small>
      <div className="row">
        <div style={{ flex: 1, minWidth: 240 }}>
          <small>Login (email yerinə)</small>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin" />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <small>Şifrə</small>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      <button className="primary" onClick={login}>Daxil ol</button>
    </div>
  );
}
