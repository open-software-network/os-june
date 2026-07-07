import { IconPencil } from "central-icons/IconPencil";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { BackButton } from "../../components/ui/BackButton";

/** A canonical / legacy status chip shown above each specimen. */
function Flag({ kind }: { kind: "canonical" | "legacy" }) {
  return (
    <span className={kind === "canonical" ? "sg-flag sg-flag-ok" : "sg-flag sg-flag-no"}>
      {kind === "canonical" ? "canonical" : "legacy, do not copy"}
    </span>
  );
}

export function Buttons() {
  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Buttons</h1>
      <p className="sg-section-intro">
        Every button class in the app, shown live. The `primary-action` family and `icon-button` are
        canonical. The `btn` family is a parallel legacy set kept working for old surfaces; do not
        copy it into new work. There is no shared `Button` React component yet, only these CSS
        families.
      </p>

      <h2 className="sg-subheading">Canonical: primary-action family</h2>
      <div className="sg-row">
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">primary-action</span>
          </div>
          <button type="button" className="primary-action">
            Cancel
          </button>
        </div>
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">primary-action primary-solid</span>
          </div>
          <button type="button" className="primary-action primary-solid">
            Confirm
          </button>
        </div>
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">primary-action primary-solid primary-destructive</span>
          </div>
          <button type="button" className="primary-action primary-solid primary-destructive">
            Delete
          </button>
        </div>
      </div>

      <h2 className="sg-subheading">Canonical: disabled state</h2>
      <div className="sg-row">
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">primary-action (disabled)</span>
          </div>
          <button type="button" className="primary-action" disabled>
            Cancel
          </button>
        </div>
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">primary-action primary-solid (disabled)</span>
          </div>
          <button type="button" className="primary-action primary-solid" disabled>
            Confirm
          </button>
        </div>
      </div>

      <h2 className="sg-subheading">Canonical: icon-button</h2>
      <div className="sg-row">
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">icon-button</span>
          </div>
          <button type="button" className="icon-button" aria-label="Edit">
            <IconPencil size={16} />
          </button>
        </div>
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">icon-button icon-button-destructive</span>
          </div>
          <button type="button" className="icon-button icon-button-destructive" aria-label="Delete">
            <IconTrashCan size={16} />
          </button>
        </div>
      </div>

      <h2 className="sg-subheading">Navigation: BackButton</h2>
      <div className="sg-row">
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">BackButton (icon only)</span>
          </div>
          <BackButton label="Back" onClick={() => {}} />
        </div>
        <div className="sg-card">
          <Flag kind="canonical" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">BackButton (labeled)</span>
          </div>
          <BackButton label="Back to settings" onClick={() => {}}>
            Settings
          </BackButton>
        </div>
      </div>

      <h2 className="sg-subheading">Legacy: btn family</h2>
      <p className="sg-note">
        Kept working for surfaces built before `primary-action`. Reach for `primary-action` in new
        work instead.
      </p>
      <div className="sg-row">
        <div className="sg-card">
          <Flag kind="legacy" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">btn btn-primary</span>
          </div>
          <button type="button" className="btn btn-primary">
            Primary
          </button>
        </div>
        <div className="sg-card">
          <Flag kind="legacy" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">btn btn-secondary</span>
          </div>
          <button type="button" className="btn btn-secondary">
            Secondary
          </button>
        </div>
        <div className="sg-card">
          <Flag kind="legacy" />
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">btn btn-ghost</span>
          </div>
          <button type="button" className="btn btn-ghost">
            Ghost
          </button>
        </div>
      </div>

      <div className="sg-card" style={{ marginTop: "var(--sp-8)" }}>
        <div className="sg-eyebrow">BrandPrimaryButton</div>
        <p className="sg-note" style={{ marginTop: 0 }}>
          Reserved for onboarding hero moments (the animated border-beam continue button). It is not
          a general primary button; not rendered here on purpose so it doesn't read as a reusable
          default. Source: `src/components/ui/BrandPrimaryButton.tsx`.
        </p>
      </div>
    </div>
  );
}
