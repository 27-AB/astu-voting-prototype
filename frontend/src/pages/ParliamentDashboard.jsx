import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  castVote,
  getCandidates,
  getElectionStatus,
  getFinalResults,
  getAnnouncements,
  logout,
} from "../api";

const POSITIONS = ["President", "Vice President", "Secretary"];

export default function ParliamentDashboard() {
  const [status, setStatus] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [results, setResults] = useState(null);
  const [announcements, setAnnouncements] = useState([]);
  const [token, setToken] = useState("");
  const [selections, setSelections] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [election, notices] = await Promise.all([getElectionStatus(), getAnnouncements()]);
        if (!active) return;
        setStatus(election);
        setAnnouncements(notices);
        setCandidates(election.phase === "scheduled" ? [] : await getCandidates());
        setError("");
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    }
    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (status?.phase !== "closed" || results) return;
    let active = true;
    getFinalResults()
      .then((finalResults) => {
        if (active) setResults(finalResults);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });
    return () => {
      active = false;
    };
  }, [status, results]);

  async function submitBallot(event) {
    event.preventDefault();
    const candidateIds = POSITIONS.map((position) => Number(selections[position]));
    if (!token.trim() || candidateIds.some((id) => !Number.isInteger(id))) {
      setError("Enter your one-time token and select one candidate for all three positions.");
      return;
    }
    setError("");
    setNotice("");
    setSubmitting(true);
    try {
      await castVote(token.trim(), candidateIds);
      setToken("");
      setNotice("Your single parliamentary ballot has been recorded.");
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  function signOut() {
    logout();
    navigate("/", { replace: true });
  }

  const winnerRows = results?.winners || [];
  return (
    <main className="page authority-page">
      <section className="card authority-card">
        <div className="logo">ASTU · PARLIAMENTARY VOTING</div>
        <h1>Parliament voter ballot</h1>
        <p className="muted">
          Each registered and eligible parliament member has one ballot. Every
          ballot selects one candidate for President, Vice President, and Secretary.
        </p>
        {status && (
          <p className="authority-deadline">
            {status.phase === "scheduled"
              ? `Voting opens ${new Date(status.election_start_time).toLocaleString()}`
              : status.phase === "closed"
                ? "Voting has closed."
                : "Voting is open."}
          </p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="success" role="status">{notice}</p>}
        {announcements.length > 0 && (
          <section className="authority-proposals" aria-label="Election notifications">
            <h2>Election notifications</h2>
            {announcements.map((announcement) => (
              <article className="proposal" key={announcement.id}>
                <h3>{announcement.title}</h3>
                <p>{announcement.body}</p>
              </article>
            ))}
          </section>
        )}

        {status?.phase === "closed" ? (
          <section className="authority-results">
            <h2>Final election results</h2>
            {results ? (
              <ol className="candidate-rankings">
                {POSITIONS.map((position) => {
                  const winner = winnerRows.find((entry) => entry.position === position);
                  return (
                    <li className="candidate-rank" key={position}>
                      <strong>{position}: {winner?.name || "No winner"}</strong>
                      {winner && <span>Combined score: {winner.final_score}/100</span>}
                    </li>
                  );
                })}
              </ol>
            ) : <p className="muted">Loading the official final ranking...</p>}
          </section>
        ) : (
          <>
            <section className="authority-proposals">
              <h2>Candidate proposals</h2>
              {POSITIONS.map((position) => (
                <section key={position}>
                  <h3>{position}</h3>
                  {candidates.filter((candidate) => candidate.position === position).map((candidate) => (
                    <article className="proposal" key={candidate.id}>
                      <h4>{candidate.name}</h4>
                      <p>{candidate.manifesto}</p>
                      {status?.phase === "open" && (
                        <p className="score-summary">
                          Judges’ proposal average: {candidate.judge_score ?? "Pending"}/20
                        </p>
                      )}
                    </article>
                  ))}
                </section>
              ))}
            </section>
            {status?.phase === "open" && status.judging_complete && !notice && (
              <form className="authority-ballot" onSubmit={submitBallot}>
                <label htmlFor="ballot-token">Your single-use voting token</label>
                <input
                  id="ballot-token"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                {POSITIONS.map((position) => (
                  <fieldset key={position}>
                    <legend>{position}</legend>
                    {candidates.filter((candidate) => candidate.position === position).map((candidate) => (
                      <label className="authority-candidate" key={candidate.id}>
                        <input
                          type="radio"
                          name={`candidate-${position}`}
                          value={candidate.id}
                          checked={selections[position] === String(candidate.id)}
                          onChange={(event) => setSelections((current) => ({
                            ...current,
                            [position]: event.target.value,
                          }))}
                        />
                        <span>{candidate.name}</span>
                      </label>
                    ))}
                  </fieldset>
                ))}
                <button className="btn" disabled={submitting}>
                  {submitting ? "Submitting..." : "Submit my one ballot"}
                </button>
              </form>
            )}
            {status?.phase === "open" && !status.judging_complete && (
              <p className="warning">Voting is paused until both judges score every candidate proposal.</p>
            )}
          </>
        )}
        <button className="link" onClick={signOut}>Sign out</button>
      </section>
    </main>
  );
}
