import type { ReactNode } from "react";
import { BorderBeam } from "border-beam";
import { JuneMark } from "../account/AccountGate";

/**
 * One onboarding screen = one welcome-card: a serif title, at most one muted
 * line, then whatever the step needs. Reuses the sign-in and trial gates'
 * classes so first-run is literally the same surface the rest of the app
 * greets users with — not a separate tour. The June mark introduces the
 * brand on the first screen only; after that the type carries it.
 */
export function StepCard({
  title,
  subtitle,
  mark,
  wide,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Show the June mark above the title (the welcome screen). */
  mark?: boolean;
  /** Steps with a demo card or timeline get a little more room. */
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={`welcome-card onboarding-card${wide ? " trial-card" : ""}`}
    >
      {mark ? (
        <span className="welcome-mark" aria-hidden>
          <JuneMark />
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
      <OnboardingPrimaryButton disabled={continueDisabled} onClick={onContinue}>
        {continueLabel}
      </OnboardingPrimaryButton>
      {onSkip ? (
        <button type="button" className="onboarding-skip" onClick={onSkip}>
          {skipLabel}
        </button>
      ) : null}
    </div>
  );
}

export function OnboardingPrimaryButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <BorderBeam
      active={!disabled}
      borderRadius={10}
      className="onboarding-primary-beam"
      colorVariant="sunset"
      duration={4.8}
      size="sm"
      staticColors
      strength={0.22}
      theme="light"
    >
      <button
        type="button"
        className="primary-action onboarding-continue"
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </BorderBeam>
  );
}
