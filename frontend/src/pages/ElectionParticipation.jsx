import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { chooseElectionParticipation, getElectionParticipation, logout } from "../api";
import Brand from "../components/Brand";

const emptyProfile = { position: "President", bio: "", manifesto: "" };

export default function ElectionParticipation() {
  const [participation, setParticipation] = useState(null);
  const [choice, setChoice] = useState("NONE");
  const [profile, setProfile] = useState(emptyProfile);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    getElectionParticipation()
      .then((data) => {
        setParticipation(data);
        setChoice(data.election_role || "NONE");
        if (data.candidate_profile) {
          setProfile({
            position: data.candidate_profile.position,
            bio: data.candidate_profile.bio,
            manifesto: data.candidate_profile.manifesto,
          });
        }
      })
      .catch((requestError) => setError(requestError.message));
  }, []);

  async function saveChoice(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const data = await chooseElectionParticipation(
        choice,
        choice === "CANDIDATE" ? profile : undefined,
      );
      setParticipation((previous) => ({
        ...previous,
        election_role: data.election_role,
        can_change_choice: previous?.can_change_choice,
      }));
      if (choice === "CANDIDATE") navigate("/candidate");
      if (choice === "VOTER") navigate("/eligibility");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  function signOut() {
    logout();
    navigate("/", { replace: true });
  }

  if (!participation && !error) {
    return <main className="page"><section className="card"><Brand /><p className="muted">Loading election choices...</p></section></main>;
  }

  return (
    <main className="page">
      <section className="card participation-card">
        <Brand label="Election participation" />
        <h1>Choose how you will participate</h1>
        <p className="muted">
          Select one role for this election. You may change your choice until registration closes,
          12 hours before voting begins.
        </p>
        {participation?.can_change_choice ? (
          <form onSubmit={saveChoice}>
            <fieldset className="participation-options">
              <legend>Your election role</legend>
              <label className="participation-option">
                <input type="radio" name="choice" value="CANDIDATE" checked={choice === "CANDIDATE"} onChange={() => setChoice("CANDIDATE")} />
                Candidate
              </label>
              <label className="participation-option">
                <input type="radio" name="choice" value="VOTER" checked={choice === "VOTER"} onChange={() => setChoice("VOTER")} />
                Parliamentary voter
              </label>
              <label className="participation-option">
                <input type="radio" name="choice" value="NONE" checked={choice === "NONE"} onChange={() => setChoice("NONE")} />
                No election registration
              </label>
            </fieldset>
            {choice === "CANDIDATE" && (
              <div className="candidate-profile-form">
                <label htmlFor="candidate-position">Position</label>
                <select id="candidate-position" value={profile.position} onChange={(event) => setProfile({ ...profile, position: event.target.value })}>
                  <option>President</option>
                  <option>Vice President</option>
                  <option>Secretary</option>
                </select>
                <label htmlFor="candidate-bio">Biography</label>
                <textarea id="candidate-bio" rows="3" maxLength="500" value={profile.bio} onChange={(event) => setProfile({ ...profile, bio: event.target.value })} />
                <label htmlFor="candidate-manifesto">Proposal / manifesto</label>
                <textarea id="candidate-manifesto" rows="7" maxLength="5000" value={profile.manifesto} onChange={(event) => setProfile({ ...profile, manifesto: event.target.value })} />
              </div>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn" disabled={saving}>
              {saving ? "Saving..." : "Save election choice"}
            </button>
          </form>
        ) : (
          <div className="warning">
            <strong>Role selection is closed.</strong>
            <p>Your saved choice: {participation?.election_role || "No registration"}</p>
          </div>
        )}
        <button className="link" onClick={signOut}>Sign out</button>
      </section>
    </main>
  );
}
