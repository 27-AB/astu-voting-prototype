import astuLogo from "../assets/astu-logo.jpg";

export default function Brand({ label }) {
  return (
    <div className="brand">
      <img className="brand-logo" src={astuLogo} alt="Adama Science and Technology University" />
      {label && <span className="brand-label">{label}</span>}
    </div>
  );
}
