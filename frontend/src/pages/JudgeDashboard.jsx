import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getElectionStatus, getJudgeCandidates, logout, submitJudgeScore } from "../api";

const POSITIONS = ["President", "Vice President", "Secretary"];

export default function JudgeDashboard() {
  const [status, setStatus] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [scores, setScores] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const navigate = useNavigate();
  const judgeName = sessionStorage.getItem("student_name") || "Student Affairs Judge";

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [election, roster] = await Promise.all([getElectionStatus(), getJudgeCandidates()]);
        if (!active) return;
        setStatus(election);
        setCandidates(roster);
        setScores((current) => {
          const next = { ...current };
          roster.forEach((candidate) => {
            if (next[candidate.id] === undefined) {
              next[candidate.id] = candidate.my_score === null ? "" : String(candidate.my_score);
            }
          });
          return next;
        });
        setError("");
      } catch (refreshError) {
        if (active) setError(refreshError.message);
      }
    }
    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  async function saveScore(candidate) {
    const value = Number(scores[candidate.id]);
    if (!Number.isInteger(value) || value < 0 || value > 20) {
      setError("Each proposal score must be a whole number from 0 to 20.");
      return;
    }
    setError("");
    setNotice("");
    setSavingId(candidate.id);
    try {
      await submitJudgeScore(candidate.id, value);
      setCandidates((current) => current.map((entry) =>
        entry.id === candidate.id ? { ...entry, my_score: value } : entry
      ));
      setNotice(`Saved your score for ${candidate.name}.`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSavingId(null);
    }
  }

  function signOut() {
    logout();
    navigate("/", { replace: true });
  }

  return (
    <main className="page authority-page">
      <section className="card authority-card">
        <div className="logo">ASTU · STUDENT AFFAIRS JUDGE</div>
        <p className="authority-eyebrow">Welcome, {judgeName}</p>
        <h1>Candidate proposal evaluations</h1>
        <p className="muted">
          Score each candidate proposal from 0 to 20. Your score can be revised
          until the election closes. Both appointed judges must score every
          candidate before the parliamentary ballot is accepted.
        </p>
        {status && (
          <p className="authority-deadline">
            {status.phase === "closed"
              ? "Scoring is locked because the election has closed."
              : status.judging_complete
                ? "Every proposal has been scored by both judges."
                : "Some proposals still need a score from one or both judges."}
          </p>
        )}
        {notice && <p className="success" role="status">{notice}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {POSITIONS.map((position) => {
          const entries = candidates.filter((candidate) => candidate.position === position);
          return (
            <section className="authority-proposals" key={position}>
              <h2>{position}</h2>
              {entries.length === 0 && <p className="muted">No candidates have been added.</p>}
              {entries.map((candidate) => (
                <article className="proposal judge-proposal" key={candidate.id}>
                  <h3>{candidate.name}</h3>
                  <p>{candidate.manifesto}</p>
                  <label htmlFor={`score-${candidate.id}`}>Proposal score (0–20)</label>
                  <div className="score-editor">
                    <input
                      id={`score-${candidate.id}`}
                      type="number"
                      min="0"
                      max="20"
                      step="1"
                      value={scores[candidate.id] ?? ""}
                      disabled={status?.phase === "closed"}
                      onChange={(event) => setScores((current) => ({
                        ...current,
                        [candidate.id]: event.target.value,
                      }))}
                    />
                    <button
                      className="btn"
                      type="button"
                      disabled={savingId === candidate.id || status?.phase === "closed"}
                      onClick={() => saveScore(candidate)}
                    >
                      {savingId === candidate.id ? "Saving..." : "Save score"}
                    </button>
                  </div>
                  <p className="muted">
                    {candidate.my_score === null ? "Not scored yet" : `Your saved score: ${candidate.my_score}/20`}
                  </p>
                </article>
              ))}
            </section>
          );
        })}
        <button className="link" onClick={signOut}>Sign out</button>
      </section>
    </main>
  );
}
