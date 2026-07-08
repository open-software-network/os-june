import type { ReactNode } from "react";
import { JuneGlassMark } from "../brand/JuneGlassMark";
import { BrandPrimaryButton } from "../ui/BrandPrimaryButton";

/**
 * One onboarding screen = one welcome-card: a serif title, at most one muted
 * line, then whatever the step needs. Reuses the sign-in gate chrome so
 * first-run is literally the same surface the rest of the app greets users
 * with — not a separate tour. The June mark introduces the brand on the first
 * screen only; after that the type carries it.
 */
export function StepCard({
  title,
  subtitle,
  mark,
  wide,
  className,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Show the June mark above the title (the welcome screen). */
  mark?: boolean;
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
      {mark ? (
        <span className="welcome-mark-glass" aria-hidden>
          <JuneGlassMark />
        </span>
      ) : null}
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
