import { useEffect, useRef, useState } from "react";
import {
  isSubscriptionActive,
  useTrialCheckout,
} from "../../../lib/trial-checkout";
import type { AccountStatus } from "../../../lib/tauri";
import { Spinner } from "../../ui/Spinner";
import { StepActions, StepHeading } from "../StepChrome";

/**
 * The free-trial step, deliberately placed after permissions and setup
 * (the user has invested) and right before the hands-on dictation practice
 * (the practice runs the real, metered pipeline, and the payoff lands
 * seconds after the card does). One click opens Stripe Checkout directly —
 * no portal page in between — and the hook polls until the subscription
 * appears, then pulls the app back to the foreground.
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
      <section className="onboarding-step">
        <StepHeading
          title="You're in! Your free trial is active"
          subtitle="No charge until the trial ends, and you can cancel anytime from your account. Now for the fun part."
        />
        <StepActions
          continueLabel="Try your first dictation"
          onContinue={onContinue}
        />
      </section>
    );
  }

  if (checkout.phase === "waiting") {
    return (
      <section className="onboarding-step">
        <StepHeading
          title="Finish checkout in your browser"
          subtitle={
            checkout.usedPortalFallback
              ? "We opened your account portal. Start the free trial there. June will notice the moment you're done."
              : "We opened a secure Stripe checkout. June will notice the moment you're done. No need to come back and click anything."
          }
        />
        <div
          className="onboarding-browser-wait"
          role="status"
          aria-live="polite"
        >
          <span className="onboarding-browser-wait-label">
            <Spinner aria-hidden />
            <span>Waiting for your trial to start</span>
          </span>
          <button
            type="button"
            className="onboarding-skip"
            onClick={() => void checkout.checkNow()}
          >
            I've finished, check now
          </button>
          <button
            type="button"
            className="onboarding-skip"
            onClick={() => void checkout.start()}
          >
            Reopen checkout
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="onboarding-step">
      <StepHeading
        title="Start your free trial"
        subtitle="Everything you just set up (dictation, meeting notes, the agent) runs on your June membership."
      />
      <ul className="onboarding-feature-list">
        <li>
          <strong>Free to start</strong>: you won't be charged until the trial
          ends.
        </li>
        <li>
          <strong>Cancel anytime</strong>: one click in your account, keep
          access through the trial.
        </li>
        <li>
          <strong>One step left</strong>: checkout opens in your browser, then
          June brings you right back.
        </li>
      </ul>
      <StepActions
        continueLabel={
          checkout.phase === "reauth"
            ? "Confirming your sign-in…"
            : checkout.phase === "opening"
              ? "Opening checkout…"
              : "Start free trial"
        }
        continueDisabled={
          checkout.phase === "opening" || checkout.phase === "reauth"
        }
        onContinue={() => void checkout.start()}
      />
      {checkout.error ? (
        <p className="welcome-status">{checkout.error}</p>
      ) : checkout.notice ? (
        <p className="welcome-status welcome-status-info">{checkout.notice}</p>
      ) : null}
    </section>
  );
}
