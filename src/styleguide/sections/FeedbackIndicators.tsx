import { IconNoteText } from "central-icons/IconNoteText";
import { EmptyState } from "../../components/ui/EmptyState";
import { HoverTip } from "../../components/ui/HoverTip";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { ModelPrivacyChip } from "../../components/ui/ModelPrivacyChip";
import { Spinner } from "../../components/ui/Spinner";
import {
  ANONYMOUS_MODEL_DESCRIPTION,
  E2EE_MODEL_DESCRIPTION,
  type ModelPrivacyBadge,
  PRIVATE_MODEL_DESCRIPTION,
} from "../../lib/model-privacy";

const E2EE_BADGE: ModelPrivacyBadge = {
  mode: "e2ee",
  label: "E2EE",
  description: E2EE_MODEL_DESCRIPTION,
};
const PRIVATE_BADGE: ModelPrivacyBadge = {
  mode: "private",
  label: "Private mode",
  description: PRIVATE_MODEL_DESCRIPTION,
};
const ANONYMOUS_BADGE: ModelPrivacyBadge = {
  mode: "anonymous",
  label: "Anonymous mode",
  description: ANONYMOUS_MODEL_DESCRIPTION,
};

export function FeedbackIndicators() {
  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Feedback</h1>
      <p className="sg-section-intro">
        Loading, inline warnings, tooltips, privacy chips, and the shared empty state. Hover the tip
        triggers and privacy chips to see their cards.
      </p>

      <h2 className="sg-subheading">Spinner</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">Spinner</span>
          </div>
          <Spinner aria-label="Loading" />
        </div>
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">Spinner inline with text</span>
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-3)" }}>
            <Spinner aria-hidden />
            <span>Saving...</span>
          </span>
        </div>
      </div>

      <h2 className="sg-subheading">InlineNotice</h2>
      <div className="sg-stack">
        <InlineNotice tone="warning" body="This model can't run tools, so the agent may stall." />
        <InlineNotice
          tone="warning"
          eyebrow="Heads up"
          body="You're close to your monthly credit limit."
          actions={
            <button type="button" className="primary-action">
              View usage
            </button>
          }
        />
        <InlineNotice
          tone="destructive"
          role="alert"
          body="Recording failed: the microphone is in use by another app."
        />
        <InlineNotice
          tone="destructive"
          role="alert"
          eyebrow="Sync error"
          body="Your changes couldn't be saved to the local store."
          actions={
            <button type="button" className="primary-action primary-solid">
              Retry
            </button>
          }
        />
      </div>

      <h2 className="sg-subheading">HoverTip</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">HoverTip (compact)</span>
          </div>
          <HoverTip compact tip="Copy to clipboard" width={200}>
            <span className="sg-tip-trigger" tabIndex={0}>
              Compact tip
            </span>
          </HoverTip>
        </div>
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">HoverTip (rich)</span>
          </div>
          <HoverTip
            tip={
              <span>
                <strong>End-to-end encrypted.</strong> Your prompt is encrypted on your device and
                only decrypted inside a hardware-secured enclave.
              </span>
            }
          >
            <span className="sg-tip-trigger" tabIndex={0}>
              Rich card tip
            </span>
          </HoverTip>
        </div>
      </div>

      <h2 className="sg-subheading">ModelPrivacyChip</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">variant="muted"</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-4)" }}>
            <ModelPrivacyChip badge={E2EE_BADGE} variant="muted" />
            <ModelPrivacyChip badge={PRIVATE_BADGE} variant="muted" />
            <ModelPrivacyChip badge={ANONYMOUS_BADGE} variant="muted" />
          </div>
        </div>
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">variant="themed"</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-4)" }}>
            <ModelPrivacyChip badge={E2EE_BADGE} variant="themed" />
            <ModelPrivacyChip badge={PRIVATE_BADGE} variant="themed" />
            <ModelPrivacyChip badge={ANONYMOUS_BADGE} variant="themed" size="sm" />
          </div>
        </div>
      </div>

      <h2 className="sg-subheading">EmptyState</h2>
      <div className="sg-card" style={{ padding: 0, overflow: "hidden" }}>
        <EmptyState
          icon={<IconNoteText size={28} />}
          title="No notes yet"
          description="Record a meeting or start a dictation and your notes will show up here."
          action={
            <button type="button" className="primary-action primary-solid">
              New note
            </button>
          }
        />
      </div>
    </div>
  );
}
