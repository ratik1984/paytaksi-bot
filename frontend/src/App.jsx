import React, { useMemo } from "react";
import { HashRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import Home from "./pages/Home.jsx";
import Passenger from "./pages/Passenger.jsx";
import Driver from "./pages/Driver.jsx";
import Admin from "./pages/Admin.jsx";
import { clearToken } from "./lib/api.js";

function detectLockedRole() {
  const h = (window.location.hash || "").toLowerCase();
  const m = h.match(/^#\/(passenger|driver|admin)(\b|\/|\?|$)/);
  return m ? m[1] : null;
}

function roleLabel(role) {
  if (role === "passenger") return "Sərnişin";
  if (role === "driver") return "Sürücü";
  if (role === "admin") return "Admin";
  return "Ana səhifə";
}

function Nav({ lockedRole }) {
  const homeTo = lockedRole ? `/${lockedRole}` : "/";
  return (
    <div className="topbar">
      {!lockedRole && (
        <NavLink className={({ isActive }) => "chip" + (isActive ? " active" : "")} to="/">
          Ana səhifə
        </NavLink>
      )}

      {(lockedRole === "passenger" || !lockedRole) && (
        <NavLink className={({ isActive }) => "chip" + (isActive ? " active" : "")} to="/passenger">
          Sərnişin
        </NavLink>
      )}

      {(lockedRole === "driver" || !lockedRole) && (
        <NavLink className={({ isActive }) => "chip" + (isActive ? " active" : "")} to="/driver">
          Sürücü
        </NavLink>
      )}

      {(lockedRole === "admin" || !lockedRole) && (
        <NavLink className={({ isActive }) => "chip" + (isActive ? " active" : "")} to="/admin">
          Admin
        </NavLink>
      )}

      <button
        style={{ maxWidth: 160 }}
        onClick={() => {
          clearToken();
          // Keep user inside their bot's role entry
          window.location.hash = lockedRole ? `#/${lockedRole}` : "#/";
          // For safety also set pathname root (works on web)
          if (!lockedRole) window.location.pathname = "/";
        }}
      >
        Çıxış
      </button>
    </div>
  );
}

export default function App() {
  const lockedRole = useMemo(() => detectLockedRole(), []);
  const defaultPath = lockedRole ? `/${lockedRole}` : "/";

  return (
    <HashRouter>
      <div className="container">
        <Nav lockedRole={lockedRole} />
        <Routes>
          <Route path="/" element={lockedRole ? <Navigate to={defaultPath} replace /> : <Home />} />
          <Route path="/passenger" element={<Passenger />} />
          <Route path="/driver" element={<Driver />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to={defaultPath} replace />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
