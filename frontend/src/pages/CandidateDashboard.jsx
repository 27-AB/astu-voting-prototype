import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getCandidateDashboard, getCandidateProfile, getElectionParticipation, logout, updateCandidateProfile } from "../api";
import Brand from "../components/Brand";

const POSITIONS = ["President", "Vice President", "Secretary"];

export default function CandidateDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [profileMessage, setProfileMessage] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [canChangeChoice, setCanChangeChoice] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    const refresh = () => {
      getCandidateDashboard()
        .then((dashboard) => {
          if (active) {
            setData(dashboard);
            setError("");
          }
        })
        .catch((requestError) => {
          if (active) setError(requestError.message);
        });
      getElectionParticipation()
        .then((participation) => {
          if (active) setCanChangeChoice(participation.can_change_choice);
        })
        .catch((requestError) => {
          if (active) setError(requestError.message);
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    getCandidateProfile()
      .then(setProfile)
      .catch((requestError) => setError(requestError.message));
    getElectionParticipation()
      .then((participation) => setCanChangeChoice(participation.can_change_choice))
      .catch((requestError) => setError(requestError.message));
  }, []);

  async function saveProfile(event) {
    event.preventDefault();
    setSavingProfile(true);
    setError("");
    setProfileMessage("");
    try {
      setProfile(await updateCandidateProfile({
        position: profile.position,
        bio: profile.bio,
        manifesto: profile.manifesto,
      }));
      setProfileMessage("Your candidate profile was updated.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingProfile(false);
    }
  }

  function signOut() {
    logout();
    navigate("/", { replace: true });
  }

  const ownStanding = data?.own_standing;

  return (
    <main className="page authority-page">
      <section className="card authority-card">
        <Brand label="Candidate dashboard" />
        <h1>Your election standing</h1>
        {data?.phase === "scheduled" && profile && (
          <form className="candidate-profile-form" onSubmit={saveProfile}>
            <h2>Edit your candidate profile</h2>
            <p className="muted">Only you can edit this profile, and changes close when voting starts.</p>
            <label htmlFor="profile-position">Position</label>
            <select id="profile-position" value={profile.position} onChange={(event) => setProfile({ ...profile, position: event.target.value })}>
              {POSITIONS.map((position) => <option key={position}>{position}</option>)}
            </select>
            <label htmlFor="profile-bio">Biography</label>
            <textarea id="profile-bio" rows="3" maxLength="500" value={profile.bio} onChange={(event) => setProfile({ ...profile, bio: event.target.value })} />
            <label htmlFor="profile-manifesto">Proposal / manifesto</label>
            <textarea id="profile-manifesto" rows="7" maxLength="5000" value={profile.manifesto} onChange={(event) => setProfile({ ...profile, manifesto: event.target.value })} />
            {profileMessage && <p className="success" role="status">{profileMessage}</p>}
            <button className="btn" disabled={savingProfile}>{savingProfile ? "Saving..." : "Save profile"}</button>
          </form>
        )}
        <p className="muted">
          {data?.results_published
            ? "Official final rankings and proposal evaluations are now available."
            : "Proposal evaluations and candidate rankings will be published after the election closes."}
        </p>
        {data?.results_published && ownStanding && (
          <section className="candidate-highlight" aria-live="polite">
            <strong>Your current rank: #{ownStanding.rank} for {ownStanding.position}</strong>
            <span>Proposal evaluation: {ownStanding.judge_score ?? "Pending"}/20</span>
            <span>Current combined score: {ownStanding.final_score}/100</span>
          </section>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {!data && !error && <p className="muted">Loading candidate standings...</p>}
        {data?.results_published && POSITIONS.map((position) => {
          const candidates = data.standings.filter((candidate) => candidate.position === position);
          return (
            <section className="authority-results" key={position}>
              <h2>{position} rankings</h2>
              {candidates.length ? (
                <ol className="candidate-rankings">
                  {candidates.map((candidate) => (
                    <li
                      className={candidate.candidate_id === data.candidate_id ? "candidate-rank own-candidate" : "candidate-rank"}
                      key={candidate.candidate_id}
                    >
                      <div>
                        <strong>#{candidate.rank} · {candidate.name}</strong>
                        {candidate.candidate_id === data.candidate_id && <span className="muted"> (you)</span>}
                      </div>
                      <p>{candidate.manifesto}</p>
                      <span>Judge average: {candidate.judge_score ?? "Pending"}/20</span>
                      <span>Parliament votes: {candidate.parliament_votes}</span>
                      <span>Parliament share: {candidate.parliament_share}%</span>
                      <strong>Combined score: {candidate.final_score}/100</strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No candidate rankings are available yet.</p>
              )}
            </section>
          );
        })}
        <p className="muted">
          The final ranking combines the average of both judges’ proposal scores
          (30 points maximum) with each candidate’s share of parliamentary votes
          (70 points maximum).
        </p>
        <button className="btn secondary" onClick={() => navigate("/eligibility")}>
          Check parliamentary voter eligibility
        </button>
        {canChangeChoice && <button className="link" onClick={() => navigate("/participation")}>Change election participation choice</button>}
        <button className="link" onClick={signOut}>Sign out</button>
      </section>
    </main>
  );
}
