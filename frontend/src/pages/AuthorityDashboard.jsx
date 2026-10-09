import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  castVote,
  getCandidates,
  getElectionStatus,
  getFinalResults,
  logout,
  requestToken,
} from "../api";

const FINAL_POSITIONS = ["President", "Vice President", "Secretary"];

export default function AuthorityDashboard() {
  const [status, setStatus] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [results, setResults] = useState(null);
  const [token, setToken] = useState("");
  const [selections, setSelections] = useState({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [serverOffset, setServerOffset] = useState(0);
  const [clock, setClock] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [tokenLoading, setTokenLoading] = useState(false);
  const navigate = useNavigate();
  const displayName = sessionStorage.getItem("student_name") || "Authorized Elector";

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const election = await getElectionStatus();
        if (!active) return;
        setStatus(election);
        setServerOffset(Date.parse(election.server_time) - Date.now());
        setClock(Date.now());
        setError("");
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    };

    getCandidates()
      .then((ballotCandidates) => {
        if (active) setCandidates(ballotCandidates);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });
    refresh();
    const pollId = window.setInterval(refresh, 1000);
    const clockId = window.setInterval(() => setClock(Date.now()), 250);
    return () => {
      active = false;
      window.clearInterval(pollId);
      window.clearInterval(clockId);
    };
  }, []);

  const estimatedServerNow = clock + serverOffset;
  const isClosed =
    status?.phase === "closed" ||
    (status && estimatedServerNow >= Date.parse(status.election_end_time));

  useEffect(() => {
    if (!isClosed || results) return;
    let active = true;
    getFinalResults()
      .then((finalResults) => {
        if (active) {
          setResults(finalResults);
          setError("");
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });
    return () => {
      active = false;
    };
  }, [isClosed, results]);

  const candidatesByPosition = useMemo(
    () =>
      candidates.reduce((groups, candidate) => {
        groups[candidate.position] ||= [];
        groups[candidate.position].push(candidate);
        return groups;
      }, {}),
    [candidates],
  );

  async function handleRequestToken() {
    setError("");
    setTokenLoading(true);
    try {
      const issued = await requestToken();
      setToken(issued.token);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setTokenLoading(false);
    }
  }

  async function handleVote(event) {
    event.preventDefault();
    const candidateIds = Object.values(selections).map(Number);
    if (!token || candidateIds.length === 0) {
      setError("Choose at least one candidate and generate your ballot token.");
      return;
    }

    setError("");
    setSubmitting(true);
    try {
      await castVote(token, candidateIds);
      setToken("");
      setMessage("Your weighted ballot has been securely recorded.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  function signOut() {
    logout();
    navigate("/", { replace: true });
  }

  if (!status) {
    return (
      <main className="page">
        <div className="card authority-card">
          <h1>Authority Dashboard</h1>
          <p className="muted">{error || "Loading the official election schedule..."}</p>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </main>
    );
  }

  const isOpen =
    status.phase === "open" &&
    estimatedServerNow >= Date.parse(status.election_start_time) &&
    estimatedServerNow < Date.parse(status.election_end_time);

  if (isClosed) {
    return (
      <main className="page authority-page">
        <section className="card authority-card authority-closed">
          <div className="logo">ASTU · AUTHORITY ELECTOR</div>
          <p className="authority-eyebrow">With sincere appreciation, {displayName}</p>
          <h1>Thank you for your service</h1>
          <p className="authority-farewell">
            Authorized Elector, the voting period has officially concluded.
            We extend our deepest gratitude for your guidance, leadership,
            and pivotal role in shaping the future of our institution.
          </p>
          <section className="authority-results" aria-live="polite">
            <h2>Final election results</h2>
            {results ? (
              <dl>
                {FINAL_POSITIONS.map((position) => {
                  const winner = results.winners.find((entry) => entry.position === position);
                  return (
                    <div className="result-row" key={position}>
                      <dt>{position}</dt>
                      <dd>
                        {winner
                          ? `${winner.name} · ${winner.votes} weighted points`
                          : "No result available"}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p className={error ? "error" : "muted"}>
                {error || "Verifying and loading the official final tally..."}
              </p>
            )}
          </section>
          <button className="link" onClick={signOut}>Sign out</button>
        </section>
      </main>
    );
  }

  const deadline = Date.parse(status.election_end_time);
  const remainingMs = Math.max(0, deadline - estimatedServerNow);
  const remainingMinutes = Math.floor(remainingMs / 60000);
  const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);

  return (
    <main className="page authority-page">
      <section className="card authority-card">
        <div className="logo">ASTU · AUTHORITY ELECTOR</div>
        <p className="authority-eyebrow">Welcome, {displayName}</p>
        <h1>Your authority ballot carries 3 points</h1>
        <p className="muted">
          Your elector status is verified by the university. Vote weight is
          determined securely by the server and cannot be changed from this page.
        </p>
        <p className="authority-deadline" aria-live="polite">
          {isOpen
            ? `Voting closes in ${remainingMinutes}m ${remainingSeconds}s`
            : `Voting opens ${new Date(status.election_start_time).toLocaleString()}`}
        </p>

        {!isOpen ? (
          <section className="authority-proposals">
            <h2>Candidate proposals</h2>
            {candidates.length ? candidates.map((candidate) => (
              <article className="proposal" key={candidate.id}>
                <h3>{candidate.name} <span>· {candidate.position}</span></h3>
                <p>{candidate.manifesto}</p>
              </article>
            )) : <p className="muted">Candidate proposals are not available.</p>}
          </section>
        ) : message ? (
          <p className="success" role="status">{message}</p>
        ) : !token ? (
          <button className="btn" onClick={handleRequestToken} disabled={tokenLoading}>
            {tokenLoading ? "Preparing authority ballot..." : "Create my secure authority ballot"}
          </button>
        ) : (
          <form className="authority-ballot" onSubmit={handleVote}>
            <p className="muted">
              Your anonymous ballot token is ready. Select one candidate for
              each available position, then submit once.
            </p>
            {Object.entries(candidatesByPosition).map(([position, entries]) => (
              <fieldset key={position}>
                <legend>{position}</legend>
                {entries.map((candidate) => (
                  <label className="authority-candidate" key={candidate.id}>
                    <input
                      type="radio"
                      name={`position-${position}`}
                      value={candidate.id}
                      checked={selections[position] === String(candidate.id)}
                      onChange={(event) =>
                        setSelections((current) => ({
                          ...current,
                          [position]: event.target.value,
                        }))
                      }
                    />
                    <span>
                      <strong>{candidate.name}</strong>
                      <small>{candidate.manifesto}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
            <button className="btn" disabled={submitting}>
              {submitting ? "Submitting ballot..." : "Submit weighted ballot"}
            </button>
          </form>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <button className="link" onClick={signOut}>Sign out</button>
      </section>
    </main>
  );
}
