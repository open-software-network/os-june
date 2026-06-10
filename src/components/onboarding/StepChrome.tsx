import type { ReactNode } from "react";

/** Serif headline + optional supporting line, shared by every step. */
export function StepHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <header className="onboarding-heading">
      <h1 className="onboarding-title">{title}</h1>
      {subtitle ? <p className="onboarding-subtitle">{subtitle}</p> : null}
    </header>
  );
}

/**
 * Footer action row. Primary continue button plus an optional quiet skip
 * affordance — Wispr's pattern: one obvious next step, escape hatch in the
 * corner, never two competing buttons.
 */
export function StepActions({
  continueLabel = "Continue",
  continueDisabled,
  onContinue,
  onSkip,
  skipLabel = "Skip for now",
}: {
  continueLabel?: string;
  continueDisabled?: boolean;
  onContinue: () => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  return (
    <div className="onboarding-actions">
      <button
        type="button"
        className="primary-action primary-solid onboarding-continue"
        disabled={continueDisabled}
        onClick={onContinue}
      >
        {continueLabel}
      </button>
      {onSkip ? (
        <button type="button" className="onboarding-skip" onClick={onSkip}>
          {skipLabel}
        </button>
      ) : null}
    </div>
  );
}
