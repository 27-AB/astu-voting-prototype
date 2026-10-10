// Login.jsx: the student enters UGR ID and password.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../api";

export default function Login() {
  // "state" = values the page remembers. When they change, the page redraws.
  const [ugrId, setUgrId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate(); // lets us jump to another page

  async function handleSubmit(e) {
    e.preventDefault(); // stop the browser from reloading the page
    setError("");

    if (!ugrId.trim() || !password) {
      setError("Enter your UGR ID and password.");
      return;
    }

    setLoading(true);
    try {
      const data = await login(ugrId.trim(), password); // calls api.js
      navigate(
        data.student.voter_type === "AUTHORITY"
          ? "/judge"
          : data.student.is_candidate
            ? "/candidate"
            : "/eligibility",
      );
    } catch (err) {
      setError(err.message); // e.g. "Invalid ID or password"
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <div className="card">
        <div className="logo">ASTU</div>
        <h1>Student election</h1>
        <p className="muted">Sign in with your UGR ID to check if you can vote.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="ugr">UGR ID</label>
          <input
            id="ugr"
            placeholder="UGR/0001/15"
            value={ugrId}
            onChange={(e) => setUgrId(e.target.value)}
          />

          <label htmlFor="pw">Password</label>
          <input
            id="pw"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && <p className="error">{error}</p>}

          <button className="btn" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
