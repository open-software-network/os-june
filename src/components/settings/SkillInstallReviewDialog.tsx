import { IconBlock } from "central-icons/IconBlock";
import { IconBolt } from "central-icons/IconBolt";
import { IconCode } from "central-icons/IconCode";
import { IconFileText } from "central-icons/IconFileText";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useEffect, useId, useState } from "react";
import {
  SKILL_TRUST_MODEL_COPY,
  findingTone,
  type HermesAdminMode,
  type SkillInstallReview,
} from "../../lib/hermes-admin";
import { Dialog } from "../ui/Dialog";

/** The decision the review resolves with. `proceed` false is a cancel; `force`
 * is true only when the user confirmed an override for a gated, scanned skill. */
export type SkillInstallReviewDecision = { proceed: boolean; force: boolean };

type SkillInstallReviewDialogProps = {
  review: SkillInstallReview;
  /** The runtime mode the install targets, so the sandbox/full-mode implications
   * of running the skill's scripts are honest. */
  mode: HermesAdminMode;
  /** Called with the user's decision. Cancel resolves `{ proceed: false }`. */
  onDecide: (decision: SkillInstallReviewDecision) => void;
};

/**
 * The native security review screen (spec 07) shown before a Skills Hub install
 * that is not trusted. It surfaces what the user is trusting BEFORE they install:
 * the source + trust level, the install identifier, the upstream repo/URL, the
 * scan's summarized findings and exact affected files, what the skill bundles
 * (scripts/templates/references), the agent capabilities it may use, and the
 * sandbox/full-mode implications of running it.
 *
 * It mirrors June's native dialog patterns (the shared {@link Dialog}) rather
 * than a `window.confirm`, and enforces the trust model:
 *
 * - a caution/unknown verdict installs only after an explicit confirmation;
 * - a gated, scanned verdict requires ticking the force-override checkbox first;
 * - a dangerous verdict is BLOCKED: the dialog offers no install/override path.
 */
export function SkillInstallReviewDialog({
  review,
  mode,
  onDecide,
}: SkillInstallReviewDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const ackId = useId();
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  const hasScripts = review.bundle.some(
    (line) => line.label === "Helper scripts",
  );

  // Reset the acknowledgement whenever the reviewed skill changes.
  useEffect(() => {
    setAcknowledged(false);
  }, [review.identifier]);

  const cancel = () => onDecide({ proceed: false, force: false });
  const confirm = () =>
    onDecide({ proceed: true, force: review.requiresForce });

  // The confirm button is gated: blocked verdicts cannot install at all; a
  // force-override path requires the acknowledgement checkbox first.
  const confirmDisabled =
    !review.installable || (review.requiresForce && !acknowledged);

  const confirmLabel = !review.installable
    ? "Cannot install"
    : review.requiresForce
      ? "Install anyway"
      : "Install";

  return (
    <Dialog
      open
      onClose={cancel}
      width={520}
      className="skill-review-dialog"
      leading={<VerdictIcon tone={review.verdict.tone} />}
      title={review.name}
      description={review.verdict.headline}
      footer={
        <>
          <button type="button" className="primary-action" onClick={cancel}>
            Cancel
          </button>
          {review.installable ? (
            <button
              type="button"
              className={`primary-action primary-solid${
                review.verdict.tone === "danger" ||
                review.verdict.tone === "caution"
                  ? " primary-destructive"
                  : ""
              }`}
              onClick={confirm}
              disabled={confirmDisabled}
            >
              {confirmLabel}
            </button>
          ) : null}
        </>
      }
    >
      <div className="skill-review-body">
        <p className="skill-review-model">{SKILL_TRUST_MODEL_COPY}</p>

        <dl className="skill-review-facts">
          <div className="skill-review-fact">
            <dt>Source</dt>
            <dd>
              {review.sourceLabel}
              <span
                className="skill-review-verdict-pill"
                data-tone={review.verdict.tone}
              >
                {review.verdict.label}
              </span>
            </dd>
          </div>
          {review.directUrl ? (
            <div className="skill-review-fact">
              <dt>Install type</dt>
              <dd>Single SKILL.md file fetched directly from a URL</dd>
            </div>
          ) : null}
        </dl>

        {review.summary ? (
          <p className="skill-review-summary">{review.summary}</p>
        ) : null}

        {review.findings.length > 0 ? (
          <section
            className="skill-review-section"
            aria-label="Security findings"
          >
            <h4 className="skill-review-section-title">What the scan found</h4>
            <ul className="skill-review-findings">
              {review.findings.map((finding, index) => (
                <li
                  key={`${finding.category ?? "finding"}-${index}`}
                  className="skill-review-finding"
                  data-tone={findingTone(finding)}
                >
                  {finding.category ? (
                    <span className="skill-review-finding-category">
                      {finding.category}
                    </span>
                  ) : null}
                  <span className="skill-review-finding-detail">
                    {finding.detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {review.bundle.length > 0 ? (
          <section
            className="skill-review-section"
            aria-label="What it bundles"
          >
            <h4 className="skill-review-section-title">
              <IconCode size={14} ariaHidden />
              What this skill bundles
            </h4>
            <ul className="skill-review-bundle">
              {review.bundle.map((line) => (
                <li key={line.label}>
                  <span className="skill-review-bundle-label">
                    {line.label}
                  </span>
                  <span className="skill-review-bundle-detail">
                    {line.detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {review.capabilities.length > 0 ? (
          <section
            className="skill-review-section"
            aria-label="Capabilities the skill may use"
          >
            <h4 className="skill-review-section-title">
              <IconBolt size={14} ariaHidden />
              Capabilities it may ask the agent to use
            </h4>
            <ul className="skill-review-chips">
              {review.capabilities.map((capability) => (
                <li key={capability} className="skill-review-chip">
                  {capability}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {review.affectedFiles.length > 0 ? (
          <section className="skill-review-section" aria-label="Affected files">
            <h4 className="skill-review-section-title">
              <IconFileText size={14} ariaHidden />
              Files it adds
            </h4>
            <ul className="skill-review-files">
              {review.affectedFiles.map((file) => (
                <li key={file} className="skill-review-file">
                  {file}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {review.upstreamUrls.length > 0 ? (
          <section className="skill-review-section" aria-label="Source links">
            <h4 className="skill-review-section-title">Where it comes from</h4>
            <ul className="skill-review-links">
              {review.upstreamUrls.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {hasScripts && review.installable ? (
          <p className="skill-review-runtime" role="note">
            Helper scripts run in the {modeLabel} runtime when the agent uses
            this skill. Only install it if you trust what those scripts do.
          </p>
        ) : null}

        <details className="skill-review-advanced">
          <summary>Advanced</summary>
          <dl className="skill-review-advanced-list">
            <dt>Install identifier</dt>
            <dd className="skill-review-mono">{review.identifier}</dd>
          </dl>
        </details>

        {review.installable && review.requiresForce ? (
          <label className="skill-review-ack" htmlFor={ackId}>
            <input
              id={ackId}
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            />
            <span>
              I reviewed the findings above and want to install this skill
              anyway.
            </span>
          </label>
        ) : null}

        {!review.installable ? (
          <p className="skill-review-blocked" role="alert">
            <IconBlock size={14} ariaHidden />
            Hermes blocked this skill. June will not install a skill that fails
            the security review.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The verdict icon shown in the dialog header. */
function VerdictIcon({
  tone,
}: {
  tone: SkillInstallReview["verdict"]["tone"];
}) {
  if (tone === "trusted") {
    return <IconShieldCheck size={18} ariaHidden />;
  }
  if (tone === "danger") {
    return <IconBlock size={18} ariaHidden />;
  }
  return <IconWarningSign size={18} ariaHidden />;
}
