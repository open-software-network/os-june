import type { ReactNode } from "react";

/**
 * Serif headline + optional one-line support, shared by every step. `art`
 * renders spot art above the headline (a StepSpot badge) so pitch and
 * celebration screens get one visual anchor up top.
 */
export function StepHeading({
  art,
  title,
  subtitle,
}: {
  art?: ReactNode;
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <header className="onboarding-heading">
      {art ? (
        <div className="onboarding-heading-art" aria-hidden>
          {art}
        </div>
      ) : null}
      <h1 className="onboarding-title">{title}</h1>
      {subtitle ? <p className="onboarding-subtitle">{subtitle}</p> : null}
    </header>
  );
}

/**
 * Warm circular badge around a single filled icon — the house take on the
 * spot illustration, built from tokens instead of bespoke art.
 * `tone="success"` flips it green for the trial-activated moment.
 */
export function StepSpot({
  tone,
  children,
}: {
  tone?: "success";
  children: ReactNode;
}) {
  return (
    <span className="onboarding-spot" data-tone={tone}>
      {children}
    </span>
  );
}

/**
 * Borderless icon rows: a warm icon chip beside a bolded lead-in and one
 * supporting line. Replaces the bordered prose cards so content floats on
 * the backdrop instead of stacking boxes.
 */
export function StepRows({
  items,
}: {
  items: { icon: ReactNode; title: string; body: string }[];
}) {
  return (
    <ul className="onboarding-rows">
      {items.map((item) => (
        <li key={item.title}>
          <span className="onboarding-row-icon" aria-hidden>
            {item.icon}
          </span>
          <div>
            <h2>{item.title}</h2>
            <p>{item.body}</p>
          </div>
        </li>
      ))}
    </ul>
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
