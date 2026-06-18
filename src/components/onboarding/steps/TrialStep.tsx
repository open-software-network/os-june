import { useEffect, useRef, useState } from "react";
import { IconDevices } from "central-icons/IconDevices";
import { IconLock } from "central-icons/IconLock";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import {
  isSubscriptionActive,
  useTrialCheckout,
} from "../../../lib/trial-checkout";
import type { AccountStatus } from "../../../lib/tauri";
import {
  FALLBACK_TRIAL_LENGTH_DAYS,
  TRIAL_STEPS,
  trialEndDate,
} from "../../account/TrialGate";
import { Spinner } from "../../ui/Spinner";
import { StepActions, StepCard } from "../StepChrome";

const PRIVACY_RECAP_ITEMS = [
  {
    icon: IconDevices,
    label: "Local first",
    detail: "Your data stays on your device by default.",
  },
  {
    icon: IconLock,
    label: "Private AI models",
    detail: "Inference runs on private, zero-retention models by default.",
  },
  {
    icon: IconShieldCheck,
    label: "Minimal data retention",
    detail: "June keeps only what's needed for your account.",
  },
];

/**
 * The free-trial step, deliberately placed after permissions (the user has
 * invested) and right before the hands-on dictation practice (the practice
 * runs the real, metered pipeline, and the payoff lands seconds after the
 * card does). One click opens Stripe Checkout directly — no portal page in
 * between — and the hook polls until the subscription appears, then pulls
 * the app back to the foreground. The pitch itself is the TrialGate's,
 * verbatim: same timeline, same end date, same "$0 due today".
 */
export function TrialStep({
  account,
  onRefresh,
  onContinue,
}: {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onContinue: () => void;
}) {
  // Already on a subscription when arriving here (wizard re-run after an
  // update, second machine): skip silently instead of pitching a trial to a
  // paying user.
  const initiallySubscribed = useRef(isSubscriptionActive(account)).current;
  const [activated, setActivated] = useState(false);

  const trialDays =
    account.subscription?.trialPeriodDays ?? FALLBACK_TRIAL_LENGTH_DAYS;

  const checkout = useTrialCheckout({
    account,
    onRefresh,
    onActivated: () => {
      if (!initiallySubscribed) setActivated(true);
    },
  });

  // Read through a ref so the once-only skip effect below never calls a
  // stale closure of the parent's goNext.
  const onContinueRef = useRef(onContinue);
  useEffect(() => {
    onContinueRef.current = onContinue;
  });

  useEffect(() => {
    if (initiallySubscribed) onContinueRef.current();
  }, [initiallySubscribed]);

  if (initiallySubscribed) return null;

  if (activated) {
    return (
      <StepCard
        title="You're good to go"
        subtitle="Your trial is live, and June keeps it all private."
        wide
        className="trial-card-done"
      >
        <section
          className="trial-privacy-recap"
          aria-label="How June keeps your data private"
        >
          <ul>
            {PRIVACY_RECAP_ITEMS.map(({ icon: Icon, label, detail }) => (
              <li key={label}>
                <span className="trial-privacy-icon" aria-hidden>
                  <Icon size={15} />
                </span>
                <span className="trial-privacy-label">{label}</span>
                <span className="trial-privacy-detail">{detail}</span>
              </li>
            ))}
          </ul>
        </section>
        <StepActions onContinue={onContinue} />
      </StepCard>
    );
  }

  const waiting = checkout.phase === "waiting";

  return (
    <StepCard
      title="Start your free trial"
      subtitle="Try everything June can do. Free to start, cancel anytime."
      wide
    >
      <ol className="trial-timeline" aria-label="How your free trial works">
        {TRIAL_STEPS.map(({ icon: Icon, label, detail, showsEndDate }) => (
          <li key={label}>
            <span className="trial-timeline-icon" aria-hidden>
              <Icon size={15} />
            </span>
            <div>
              <span className="trial-timeline-label">
                {label}
                {showsEndDate ? (
                  <>
                    {" "}
                    <span className="trial-timeline-date">
                      {trialEndDate(trialDays)}
                    </span>
                  </>
                ) : null}
              </span>
              <span className="trial-timeline-detail">{detail}</span>
            </div>
          </li>
        ))}
      </ol>
      {waiting ? (
        <div className="welcome-providers">
          <div
            className="welcome-auth-progress onboarding-waiting"
            role="status"
            aria-live="polite"
          >
            <span className="welcome-progress-label">
              <Spinner className="welcome-spinner" aria-hidden />
              <span>Waiting for trial...</span>
            </span>
            <button
              type="button"
              className="welcome-cancel-btn"
              onClick={() => void checkout.start()}
            >
              Reopen
            </button>
          </div>
        </div>
      ) : (
        <StepActions
          continueLabel={
            checkout.phase === "reauth"
              ? "Confirming sign-in..."
              : checkout.phase === "opening"
                ? "Opening checkout..."
                : "Start free trial"
          }
          continueDisabled={
            checkout.phase === "opening" || checkout.phase === "reauth"
          }
          onContinue={() => void checkout.start()}
        />
      )}
      <p className="trial-hint">
        {waiting
          ? checkout.usedPortalFallback
            ? "Finish in your account portal."
            : "Finish in Stripe checkout."
          : "Due today: $0"}
      </p>
      {checkout.error ? (
        <p className="welcome-status">{checkout.error}</p>
      ) : checkout.notice ? (
        <p className="welcome-status welcome-status-info">{checkout.notice}</p>
      ) : null}
    </StepCard>
  );
}
