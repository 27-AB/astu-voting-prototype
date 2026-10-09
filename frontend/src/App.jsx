// App.jsx: decides which page to show for each web address (route).
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Eligibility from "./pages/Eligibility";
import Token from "./pages/Token";
import AuthorityDashboard from "./pages/AuthorityDashboard";

function AuthorityRoute() {
  const isAuthority = sessionStorage.getItem("voter_type") === "AUTHORITY";
  const isAuthenticated = Boolean(sessionStorage.getItem("student_token"));
  return isAuthority && isAuthenticated ? <AuthorityDashboard /> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* "/" is the first page people see */}
        <Route path="/" element={<Login />} />
        <Route path="/eligibility" element={<Eligibility />} />
        <Route path="/token" element={<Token />} />
        <Route path="/authority" element={<AuthorityRoute />} />
        {/* We will add /ballot, /done, /admin here in the next steps */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}
