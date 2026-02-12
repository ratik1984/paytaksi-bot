import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import Passenger from "./pages/Passenger";
import Driver from "./pages/Driver";
import Admin from "./pages/Admin";

function RoleWrapper({ children, allowed }) {
  const location = useLocation();
  const path = location.pathname.toLowerCase();

  if (!path.includes(allowed)) {
    return <Navigate to={`/${allowed}`} replace />;
  }

  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/passenger"
          element={
            <RoleWrapper allowed="passenger">
              <Passenger />
            </RoleWrapper>
          }
        />
        <Route
          path="/driver"
          element={
            <RoleWrapper allowed="driver">
              <Driver />
            </RoleWrapper>
          }
        />
        <Route
          path="/admin"
          element={
            <RoleWrapper allowed="admin">
              <Admin />
            </RoleWrapper>
          }
        />
        <Route path="*" element={<Navigate to="/passenger" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
