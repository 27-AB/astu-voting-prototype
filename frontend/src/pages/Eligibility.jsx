// Eligibility.jsx: tells the student if they can vote (green) or not (red).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAnnouncements, getElectionStatus, getEligibility, logout } from "../api";
import Brand from "../components/Brand";

export default function Eligibility() {
  const [result, setResult] = useState(null); // null = still loading
  const [error, setError] = useState("");
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

  if (error) {
    return (
      <main className="page">
        <div className="card">
          <Brand />
          <p className="error">{error}</p>
          <button className="btn" onClick={signOut}>Back to sign in</button>
        </div>
      </main>
    );
  }

  if (!result) {
    return (
      <main className="page">
        <div className="card"><Brand /><p className="muted">Checking your eligibility...</p></div>
      </main>
    );
  }

  return (
    <main className="page">
      {result.eligible ? (
        <div className="card ok">
          <Brand label="Student election" />
          <h1>{result.election_role === "CANDIDATE" ? "You selected the candidate role" : "You are eligible for parliamentary voting"}</h1>
          {!result.parliament_member ? (
            <p>Your account is not on the approved parliament voter roster.</p>
          ) : result.election_role === "CANDIDATE" ? (
            <p>You selected the candidate role and are not registered as a parliamentary voter.</p>
          ) : result.election_role === "NONE" ? (
            <p>You selected no election registration.</p>
          ) : result.election_role !== "VOTER" ? (
            <p>Choose whether to register as a candidate, voter, or neither.</p>
          ) : result.has_received_token && result.demo_mode ? (
            <p>This local presentation uses a synthetic token; no email was sent.</p>
          ) : result.has_received_token ? (
            <p>Your one-time token was sent to your registered student email. Enter it on the ballot page.</p>
          ) : election?.phase !== "open" ? (
            <p>You are registered. Your voting token will be emailed 12 hours before the election starts.</p>
          ) : (
            <p>Check your registered student email for your token. You can check delivery status below.</p>
          )}
          {result.parliament_member && result.election_role === "VOTER" && result.registered_for_election && (result.has_received_token || election?.phase === "open") && (
            <button
              className="btn"
              onClick={() => navigate(result.has_received_token && !result.demo_mode ? "/ballot" : "/token")}
            >
              {result.has_received_token && !result.demo_mode ? "Go to ballot" : result.demo_mode ? "Open demo token" : "Check token email"}
            </button>
          )}

          {error && <p className="error" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="card no">
          <Brand label="Student election" />
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
      <button className="btn secondary" onClick={() => navigate("/participation")}>
        Change election participation choice
      </button>
      <button className="link" onClick={signOut}>Sign out</button>
    </main>
  );
}
