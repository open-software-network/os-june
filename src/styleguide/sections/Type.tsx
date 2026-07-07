import { resolveToken } from "../tokens-catalog";

const SIZE_TOKENS = [
  "--fs-2xs",
  "--fs-xs",
  "--fs-sm",
  "--fs-md",
  "--fs-lg",
  "--fs-xl",
  "--fs-2xl",
  "--fs-display",
];

export function Type() {
  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Type</h1>
      <p className="sg-section-intro">
        Weight 400 is the voice of the product. Medium (600) via var(--fw-medium) is for headings
        and structural emphasis, used sparingly. The font ships only 400 and 600 faces with
        font-synthesis off, so 500 and 700 silently render 400 and 600 - they are banned.
      </p>

      <h2 className="sg-subheading">Size ladder</h2>
      <div>
        {SIZE_TOKENS.map((name) => {
          const value = resolveToken(name);
          if (!value) return null;
          return (
            <div className="sg-type-row" key={name}>
              <span className="sg-type-specimen" style={{ fontSize: `var(${name})` }}>
                The quick brown fox
              </span>
              <span className="sg-type-tag">
                <span className="sg-token-name">{name}</span>
                <span className="sg-token-value">{value}</span>
              </span>
            </div>
          );
        })}
      </div>

      <h2 className="sg-subheading">Family roles</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-eyebrow">Sans, var(--font-sans)</div>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: "var(--fs-xl)" }}>
            The voice of the product
          </div>
        </div>
        <div className="sg-card">
          <div className="sg-eyebrow">Serif, var(--font-serif)</div>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: "var(--fs-xl)" }}>
            Headings and display moments
          </div>
        </div>
        <div className="sg-card">
          <div className="sg-eyebrow">Mono, var(--font-mono)</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-lg)" }}>
            Code and technical identifiers, sparingly
          </div>
        </div>
      </div>

      <h2 className="sg-subheading">Weight</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-eyebrow">Regular, 400</div>
          <div style={{ fontWeight: 400, fontSize: "var(--fs-xl)" }}>The quick brown fox</div>
        </div>
        <div className="sg-card">
          <div className="sg-eyebrow">Medium, var(--fw-medium)</div>
          <div style={{ fontWeight: "var(--fw-medium)", fontSize: "var(--fs-xl)" }}>
            The quick brown fox
          </div>
        </div>
      </div>
      <div className="sg-row" style={{ marginTop: "var(--sp-5)" }}>
        <div className="sg-card">
          <div className="sg-badge-no">Banned: 500 renders as 400</div>
          <div style={{ fontWeight: 500, fontSize: "var(--fs-xl)" }}>The quick brown fox</div>
        </div>
        <div className="sg-card">
          <div className="sg-badge-no">Banned: 700 renders as 600</div>
          <div style={{ fontWeight: 700, fontSize: "var(--fs-xl)" }}>The quick brown fox</div>
        </div>
      </div>
      <p className="sg-note">
        The 500 and 700 specimens are rendered literally: with font-synthesis none and only two
        faces shipped, they look identical to 400 and 600. Reach for var(--fw-medium), never a bare
        500 or 700.
      </p>

      <h2 className="sg-subheading">Do and don't</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-badge-ok">Do: sentence-case eyebrow</div>
          <div className="sg-eyebrow">Recent notes</div>
        </div>
        <div className="sg-card">
          <div className="sg-badge-no">Don't: all-caps eyebrow</div>
          <div className="sg-eyebrow" style={{ textTransform: "uppercase" }}>
            Recent notes
          </div>
        </div>
      </div>
      <div className="sg-row" style={{ marginTop: "var(--sp-5)" }}>
        <div className="sg-card">
          <div className="sg-badge-ok">Do: proportional numerals</div>
          <div style={{ fontSize: "var(--fs-2xl)" }}>1,204.75</div>
        </div>
        <div className="sg-card">
          <div className="sg-badge-no">Don't: tabular numerals</div>
          <div className="sg-tabular" style={{ fontSize: "var(--fs-2xl)" }}>
            1,204.75
          </div>
        </div>
      </div>
    </div>
  );
}
