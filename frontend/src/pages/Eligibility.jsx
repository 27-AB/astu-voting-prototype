// Eligibility.jsx: tells the student if they can vote (green) or not (red).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAnnouncements, getElectionStatus, getEligibility, logout, registerForElection } from "../api";

export default function Eligibility() {
  const [result, setResult] = useState(null); // null = still loading
  const [error, setError] = useState("");
  const [registering, setRegistering] = useState(false);
  const [election, setElection] = useState(null);
  const [announcements, setAnnouncements] = useState([]);
  const navigate = useNavigate();

  // useEffect runs once when the page opens: ask the server for the result.
  useEffect(() => {
    Promise.all([getEligibility(), getElectionStatus(), getAnnouncements()])
      .then(([eligibility, status, notices]) => {
        setResult(eligibility);
        setElection(status);
        setAnnouncements(notices);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    let active = true;
    const refreshStatus = () => {
      getElectionStatus()
        .then((status) => {
          if (active) setElection(status);
        })
        .catch((statusError) => {
          if (active) setError(statusError.message);
        });
    };
    const interval = window.setInterval(refreshStatus, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  function signOut() {
    logout();
    navigate("/");
  }

  async function handleRegistration() {
    setError("");
    setRegistering(true);
    try {
      await registerForElection();
      setResult(await getEligibility());
    } catch (registrationError) {
      setError(registrationError.message);
    } finally {
      setRegistering(false);
    }
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
          <h1>You are eligible for parliamentary voting</h1>
          {!result.parliament_member ? (
            <p>Your account is not on the approved parliament voter roster.</p>
          ) : !result.registered_for_election ? (
            <>
              <p>Register for this election to confirm your participation.</p>
              <button className="btn" onClick={handleRegistration} disabled={registering}>
                {registering ? "Registering..." : "Register as a voter"}
              </button>
            </>
          ) : result.has_received_token ? (
            <p>You already received your one-time voting token. Continue to the ballot page.</p>
          ) : election?.phase !== "open" ? (
            <p>You are registered. Token requests open when the election begins.</p>
          ) : (
            <p>Get your anonymous voting token. It is shown only once.</p>
          )}
          {result.parliament_member && result.registered_for_election && (result.has_received_token || election?.phase === "open") && (
            <button
              className="btn"
              onClick={() => navigate(result.has_received_token ? "/ballot" : "/token")}
            >
              {result.has_received_token ? "Go to ballot" : "Get my voting token"}
            </button>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="card no">
          <h1>You are not eligible to vote</h1>
          <p><strong>Reason:</strong> {result.reason}</p>
          <p className="muted">Contact the registrar or cafeteria office if you think this is a mistake.</p>
        </div>
      )}
      {announcements.length > 0 && (
        <section className="card authority-proposals" aria-label="Election notifications">
          <h2>Election notifications</h2>
          {announcements.map((announcement) => (
            <article className="proposal" key={announcement.id}>
              <h3>{announcement.title}</h3>
              <p>{announcement.body}</p>
            </article>
          ))}
        </section>
      )}
      <button className="link" onClick={signOut}>Sign out</button>
    </main>
  );
}
