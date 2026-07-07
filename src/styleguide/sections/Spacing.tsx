import { getTokenGroups, resolveToken } from "../tokens-catalog";

export function Spacing() {
  const group = getTokenGroups().find((g) => g.group === "Spacing");
  const tokens = group?.tokens ?? [];

  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Spacing</h1>
      <p className="sg-section-intro">
        A compact scale for a dense desktop UI. Each bar is sized to its token so the steps read at
        a glance.
      </p>
      <div>
        {tokens.map(({ name }) => {
          const value = resolveToken(name);
          return (
            <div className="sg-ruler-row" key={name}>
              <span className="sg-ruler-bar" style={{ width: `var(${name})` }} />
              <span className="sg-ruler-meta">
                <span className="sg-token-name">{name}</span>
                <span className="sg-token-value">{value}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
