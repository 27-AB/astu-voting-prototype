// Eligibility.jsx: tells the student if they can vote (green) or not (red).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getEligibility, logout } from "../api";

export default function Eligibility() {
  const [result, setResult] = useState(null); // null = still loading
  const [error, setError] = useState("");
  const navigate = useNavigate();

  // useEffect runs once when the page opens: ask the server for the result.
  useEffect(() => {
    getEligibility()
      .then(setResult)
      .catch((err) => setError(err.message));
  }, []);

  function signOut() {
    logout();
    navigate("/");
  }

  if (error) {
    return (
      <main className="page">
        <div className="card">
          <p className="error">{error}</p>
          <button className="btn" onClick={signOut}>Back to sign in</button>
        </div>
      </main>
    );
  }

  if (!result) {
    return (
      <main className="page">
        <div className="card"><p className="muted">Checking your eligibility...</p></div>
      </main>
    );
  }

  return (
    <main className="page">
      {result.eligible ? (
        <div className="card ok">
          <h1>You are eligible to vote</h1>
          {result.has_received_token ? (
            <p>You already received your voting token. Use it on the ballot page.</p>
          ) : (
            <p>Get your anonymous voting token. It is shown only once.</p>
          )}
          <button
            className="btn"
            onClick={() => navigate(result.has_received_token ? "/ballot" : "/token")}
          >
            {result.has_received_token ? "Go to ballot" : "Get my voting token"}
          </button>
        </div>
      ) : (
        <div className="card no">
          <h1>You are not eligible to vote</h1>
          <p><strong>Reason:</strong> {result.reason}</p>
          <p className="muted">Contact the registrar or cafeteria office if you think this is a mistake.</p>
        </div>
      )}
      <button className="link" onClick={signOut}>Sign out</button>
    </main>
  );
}
