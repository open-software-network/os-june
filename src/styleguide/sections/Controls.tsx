import { resolveToken } from "../tokens-catalog";

const CONTROLS = ["--control-xs", "--control-sm", "--control-md", "--control-lg", "--control-xl"];

export function Controls() {
  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Controls</h1>
      <p className="sg-section-intro">
        The height ladder shared by buttons, inputs, and pills, from the tightest inline control up
        to the primary action size.
      </p>
      <div className="sg-stack">
        {CONTROLS.map((name) => {
          const value = resolveToken(name);
          return (
            <div className="sg-row" key={name} style={{ alignItems: "center" }}>
              <span
                className="sg-control-block"
                style={{ height: `var(${name})`, minWidth: "120px" }}
              >
                {name.replace("--control-", "")}
              </span>
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
