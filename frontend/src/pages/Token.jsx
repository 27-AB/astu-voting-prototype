// Token.jsx: the student generates the anonymous voting token.
// The token is shown ONLY ONCE. The server cannot show it again.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { requestToken } from "../api";

export default function Token() {
  const [token, setToken] = useState(""); // empty = not generated yet
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false); // "I saved my token" checkbox
  const navigate = useNavigate();

  // We generate only when the student clicks, never automatically.
  // (Automatic requests could run twice and waste the one token.)
  async function handleGenerate() {
    setError("");
    setLoading(true);
    try {
      const data = await requestToken(); // calls api.js
      setToken(data.token);
    } catch (err) {
      setError(err.message); // e.g. "You have already received a token"
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the token and copy it by hand.");
    }
  }

  return (
    <main className="page">
      <div className="card">
        <h1>Your voting token</h1>

        {!token ? (
          <>
            <p className="muted">
              The token is your anonymous key to vote. It is not linked to your
              name, and it is shown only once.
            </p>
            {error && <p className="error">{error}</p>}
            <button className="btn" onClick={handleGenerate} disabled={loading}>
              {loading ? "Generating..." : "Generate my token"}
            </button>
            <button className="link" onClick={() => navigate("/eligibility")}>
              Back
            </button>
          </>
        ) : (
          <>
            <div className="token-box">{token}</div>

            <button className="btn secondary" onClick={handleCopy}>
              {copied ? "Copied" : "Copy token"}
            </button>

            <div className="warning">
              <strong>Keep this token secret.</strong> Anyone with it can vote
              for you. It will not be shown again, so copy it or write it down
              now.
            </div>

            {error && <p className="error">{error}</p>}

            <label className="check">
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
              />
              I have saved my token
            </label>

            <button
              className="btn"
              disabled={!saved}
              onClick={() => navigate("/ballot")}
            >
              Continue to ballot
            </button>
          </>
        )}
      </div>
    </main>
  );
}
