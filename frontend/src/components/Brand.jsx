import astuLogo from "../assets/astu-logo.png";

export default function Brand({ label }) {
  return (
    <div className="brand">
      <span className="brand-logo-frame">
        <img className="brand-logo" src={astuLogo} alt="Adama Science and Technology University" />
      </span>
      {label && <span className="brand-label">{label}</span>}
    </div>
  );
}
