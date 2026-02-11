import React, { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import { api, setToken, getToken } from './lib/api.js';
import { getInitData, expand } from './lib/telegram.js';

import Home from './pages/Home.jsx';
import Passenger from './pages/Passenger.jsx';
import Driver from './pages/Driver.jsx';
import Admin from './pages/Admin.jsx';
import AdminLogin from './pages/AdminLogin.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    expand();
    (async () => {
      try {
        if (!getToken()) {
          const initData = getInitData();
          if (initData) {
            const r = await api('/auth/telegram', { method: 'POST', body: { initData }, auth: false });
            setToken(r.token);
            setMe(r.user);
          }
        }
      } catch (e) {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function logout() {
    setToken(null);
    setMe(null);
    nav('/');
  }

  return (
    <div className="container">
      <nav>
        <Link to="/">Ana səhifə</Link>
        <Link to="/passenger">Sərnişin</Link>
        <Link to="/driver">Sürücü</Link>
        <Link to="/admin">Admin</Link>
        <button onClick={logout}>Çıxış</button>
      </nav>

      {loading ? (
        <div className="card">Yüklənir…</div>
      ) : (
        <Routes>
          <Route path="/" element={<Home me={me} />} />
          <Route path="/passenger" element={<Passenger me={me} onMe={setMe} />} />
          <Route path="/driver" element={<Driver />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin-login" element={<AdminLogin onAuthed={(u,t)=>{setMe(u);setToken(t);}} />} />
        </Routes>
      )}

      <div className="card">
        <small>
          PayTaksi MVP — Telegram Mini App. Admin panel üçün <Link to="/admin-login">admin login</Link>.
        </small>
      </div>
    </div>
  );
}
