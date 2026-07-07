const SHADOWS = ["--shadow-sm", "--shadow-md", "--shadow-lg"];

export function Elevation() {
  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Elevation</h1>
      <p className="sg-section-intro">
        Ambient, soft shadows over var(--background). Dark mode carries its own shadow overrides, so
        these just work across themes.
      </p>
      <div
        className="sg-grid"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
      >
        {SHADOWS.map((name) => (
          <div className="sg-elev-card" key={name} style={{ boxShadow: `var(${name})` }}>
            <span className="sg-token-name">{name}</span>
          </div>
        ))}
      </div>

      <h2 className="sg-subheading">Composition</h2>
      <div className="sg-elev-card" style={{ boxShadow: "var(--shadow-inset), var(--shadow-md)" }}>
        <span className="sg-token-name">var(--shadow-inset), var(--shadow-md)</span>
      </div>
      <p className="sg-note">
        Compose shadows with the inset hairline or a 1px border at the call site - rings are never
        baked into the shadow tokens.
      </p>
    </div>
  );
}
