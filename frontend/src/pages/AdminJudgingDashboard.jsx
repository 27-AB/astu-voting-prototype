import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { adminLogin, getAdminJudgingResults, logout } from "../api";

export default function AdminJudgingDashboard() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function loadResults() {
    setError("");
    setLoading(true);
    try {
      setData(await getAdminJudgingResults());
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!sessionStorage.getItem("admin_token")) return;
    getAdminJudgingResults()
      .then(setData)
      .catch((requestError) => setError(requestError.message));
  }, []);

  async function handleLogin(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await adminLogin(username.trim(), password);
      setPassword("");
      setData(await getAdminJudgingResults());
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setLoading(false);
    }
  }

  function signOut() {
    logout();
    setData(null);
    navigate("/", { replace: true });
  }

  if (!data) {
    return (
      <main className="page">
        <section className="card">
          <h1>Admin judging review</h1>
          <p className="muted">Sign in to review proposal evaluations before voting begins.</p>
          <form onSubmit={handleLogin}>
            <label htmlFor="admin-user">Admin username</label>
            <input id="admin-user" value={username} onChange={(event) => setUsername(event.target.value)} />
            <label htmlFor="admin-password">Password</label>
            <input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn" disabled={loading}>
              {loading ? "Loading..." : "Sign in"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  const grouped = new Map();
  data.results.forEach((entry) => {
    if (!grouped.has(entry.candidate_id)) {
      grouped.set(entry.candidate_id, { ...entry, scores: [] });
    }
    if (entry.score !== null && entry.score !== undefined) {
      grouped.get(entry.candidate_id).scores.push({
        name: entry.judge_name,
        score: entry.score,
      });
    }
  });

  return (
    <main className="page authority-page">
      <section className="card authority-card">
        <div className="logo">ASTU · ADMIN REVIEW</div>
        <h1>Candidate proposal evaluations</h1>
        <p className="muted">
          This confidential view is available to admins before voting opens.
          Public candidate ratings are shown after voting begins.
        </p>
        <p className={data.judging_complete ? "success" : "warning"}>
          {data.judging_complete
            ? "Both judges have scored every candidate."
            : "Waiting for both judges to score every candidate."}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {Array.from(grouped.values()).map((candidate) => (
          <article className="proposal" key={candidate.candidate_id}>
            <h2>{candidate.candidate_name} · {candidate.position}</h2>
            <p>{candidate.manifesto}</p>
            <div className="candidate-rankings">
              {[0, 1].map((index) => (
                <p key={index}>
                  {candidate.scores[index]
                    ? `${candidate.scores[index].name}: ${candidate.scores[index].score}/20`
                    : `Judge ${index + 1}: not scored`}
                </p>
              ))}
              <strong>
                Average: {candidate.scores.length === 2
                  ? `${((candidate.scores[0].score + candidate.scores[1].score) / 2).toFixed(1)}/20`
                  : "Pending"}
              </strong>
            </div>
          </article>
        ))}
        <button className="btn secondary" onClick={loadResults} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh evaluations"}
        </button>
        <button className="link" onClick={signOut}>Sign out</button>
      </section>
    </main>
  );
}
