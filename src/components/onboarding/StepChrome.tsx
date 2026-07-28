import type { ReactNode } from "react";
import { BrandPrimaryButton } from "../ui/BrandPrimaryButton";

/**
 * One onboarding screen = one welcome-card: a serif title, at most one muted
 * line, then whatever the step needs. Reuses the sign-in gate chrome so
 * first-run is literally the same surface the rest of the app greets users
 * with — not a separate tour. A small, replaceable character vignette can
 * introduce each step without becoming part of the step's behavior.
 */
export function StepCard({
  title,
  subtitle,
  illustration,
  wide,
  className,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Decorative June vignette shown above the title. */
  illustration?: ReactNode;
  /** Steps with a demo card or timeline get a little more room. */
  wide?: boolean;
  /** Extra class on the card for step-specific layout (e.g. the welcome grid). */
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className={`welcome-card onboarding-card${wide ? " wide-card" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      {illustration}
      <h1 className="welcome-title">{title}</h1>
      {subtitle ? <p className="welcome-subtitle">{subtitle}</p> : null}
      {children}
    </section>
  );
}

/**
 * Footer action: one full-width primary button (the gates' pattern), with an
 * optional quiet skip beneath. Never two competing buttons.
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
    <div className="welcome-providers">
      <BrandPrimaryButton disabled={continueDisabled} onClick={onContinue}>
        {continueLabel}
      </BrandPrimaryButton>
      {onSkip ? (
        <button type="button" className="onboarding-skip" onClick={onSkip}>
          {skipLabel}
        </button>
      ) : null}
    </div>
  );
}

export { BrandPrimaryButton as OnboardingPrimaryButton };
