import React from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import Home from "./pages/Home.jsx";
import Passenger from "./pages/Passenger.jsx";
import Driver from "./pages/Driver.jsx";
import Admin from "./pages/Admin.jsx";
import { clearToken } from "./lib/api.js";

function Nav() {
  return (
    <div className="topbar">
      <NavLink className={({isActive})=> "chip"+(isActive?" active":"")} to="/">Ana səhifə</NavLink>
      <NavLink className={({isActive})=> "chip"+(isActive?" active":"")} to="/passenger">Sərnişin</NavLink>
      <NavLink className={({isActive})=> "chip"+(isActive?" active":"")} to="/driver">Sürücü</NavLink>
      <NavLink className={({isActive})=> "chip"+(isActive?" active":"")} to="/admin">Admin</NavLink>
      <button style={{maxWidth:140}} onClick={()=>{clearToken(); location.href="/";}}>Çıxış</button>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="container">
        <Nav />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/passenger" element={<Passenger />} />
          <Route path="/driver" element={<Driver />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
