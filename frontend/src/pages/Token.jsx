import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { checkTokenEmailDelivery } from "../api";

export default function Token() {
  const [emailSent, setEmailSent] = useState(false);
  const [demoToken, setDemoToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleCheckDelivery() {
    setError("");
    setLoading(true);
    try {
      const delivery = await checkTokenEmailDelivery();
      setEmailSent(delivery.email_sent);
      setDemoToken(delivery.demo_token || "");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <div className="card">
        <h1>Your voting token</h1>
        <p className="muted">
          Your single-use token is sent to your registered student email 12
          hours before voting opens. Check your inbox and keep the token secret.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {demoToken && (
          <div className="token-box" aria-label="Demo voting token">
            {demoToken}
          </div>
        )}
        {!emailSent ? (
          <button className="btn" onClick={handleCheckDelivery} disabled={loading}>
            {loading ? "Checking..." : "Check token email delivery"}
          </button>
        ) : (
          <>
            <p className="success" role="status">
              {demoToken
                ? "Demo token ready. Copy it into the ballot."
                : "Token delivery is confirmed. Enter the token from your email on the ballot."}
            </p>
            <button className="btn" onClick={() => navigate("/ballot")}>
              Continue to ballot
            </button>
          </>
        )}
        <button className="link" onClick={() => navigate("/eligibility")}>
          Back
        </button>
      </div>
    </main>
  );
}
