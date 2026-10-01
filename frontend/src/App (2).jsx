// App.jsx: decides which page to show for each web address (route).
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Eligibility from "./pages/Eligibility";
import Token from "./pages/Token";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* "/" is the first page people see */}
        <Route path="/" element={<Login />} />
        <Route path="/eligibility" element={<Eligibility />} />
        <Route path="/token" element={<Token />} />
        {/* We will add /ballot, /done, /admin here in the next steps */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}
