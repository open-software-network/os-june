import { getTokenGroups, resolveToken } from "../tokens-catalog";

export function Radius() {
  const group = getTokenGroups().find((g) => g.group === "Radius");
  const tokens = group?.tokens ?? [];

  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Radius</h1>
      <p className="sg-section-intro">
        Corner radii, from a tight chip edge up to the full pill and the native window curve.
      </p>
      <div className="sg-grid">
        {tokens.map(({ name }) => (
          <div key={name}>
            <div className="sg-radius-square" style={{ borderRadius: `var(${name})` }} />
            <div className="sg-token-meta">
              <span className="sg-token-name">{name}</span>
              <span className="sg-token-value">{resolveToken(name)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
