// App.jsx: decides which page to show for each web address (route).
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Eligibility from "./pages/Eligibility";
import Token from "./pages/Token";
import JudgeDashboard from "./pages/JudgeDashboard";
import CandidateDashboard from "./pages/CandidateDashboard";
import ParliamentDashboard from "./pages/ParliamentDashboard";
import AdminJudgingDashboard from "./pages/AdminJudgingDashboard";

function ProtectedRoleRoute({ role, children }) {
  const hasRole = role === "candidate"
    ? sessionStorage.getItem("is_candidate") === "true"
    : sessionStorage.getItem("voter_type") === role;
  const isAuthenticated = Boolean(sessionStorage.getItem("student_token"));
  return hasRole && isAuthenticated ? children : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* "/" is the first page people see */}
        <Route path="/" element={<Login />} />
        <Route path="/eligibility" element={<Eligibility />} />
        <Route path="/token" element={<Token />} />
        <Route path="/judge" element={<ProtectedRoleRoute role="AUTHORITY"><JudgeDashboard /></ProtectedRoleRoute>} />
        <Route path="/authority" element={<Navigate to="/judge" replace />} />
        <Route path="/candidate" element={<ProtectedRoleRoute role="candidate"><CandidateDashboard /></ProtectedRoleRoute>} />
        <Route path="/ballot" element={<ParliamentDashboard />} />
        <Route path="/admin/judging" element={<AdminJudgingDashboard />} />
        {/* We will add /ballot, /done, /admin here in the next steps */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}
