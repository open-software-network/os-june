import { resolveToken } from "../tokens-catalog";

const EASES = ["--ease-out", "--ease-in-out", "--ease-spring"];
const DURATIONS = ["--t-fast", "--t-med", "--t-slow"];

export function Motion() {
  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Motion</h1>
      <p className="sg-section-intro">
        Easing curves paired with the duration scale. Hover a tile to see the curve at a
        representative duration.
      </p>
      {EASES.map((ease) => (
        <div key={ease}>
          <h2 className="sg-subheading">
            {ease} <span className="sg-token-value">{resolveToken(ease)}</span>
          </h2>
          <div
            className="sg-grid"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
          >
            {DURATIONS.map((dur) => (
              <div className="sg-card sg-motion-tile" key={dur}>
                <span
                  className="sg-motion-dot"
                  style={{
                    transitionTimingFunction: `var(${ease})`,
                    transitionDuration: `var(${dur})`,
                  }}
                />
                <div className="sg-token-meta">
                  <span className="sg-token-name">{dur}</span>
                  <span className="sg-token-value">{resolveToken(dur)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
