import { useEffect, useRef, useState } from "react";
import { IconCircleCheck } from "central-icons-filled/IconCircleCheck";
import { IconGift1 } from "central-icons-filled/IconGift1";
import {
  isSubscriptionActive,
  useTrialCheckout,
} from "../../../lib/trial-checkout";
import type { AccountStatus } from "../../../lib/tauri";
import { Spinner } from "../../ui/Spinner";
import { StepActions, StepHeading, StepSpot } from "../StepChrome";

// The no-surprise-charge story as a timeline (today / during / when it
// ends) rather than three look-alike bullets — the card ask reads as a
// sequence of guarantees, not a feature pitch.
const TRIAL_TIMELINE = [
  {
    title: "Today",
    body: "Full access, no charge.",
  },
  {
    title: "During your trial",
    body: "Cancel in one click and keep access to the end.",
  },
  {
    title: "When it ends",
    body: "Your membership starts. No charge before then.",
  },
];

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
      <section className="onboarding-step onboarding-step-hero">
        <StepHeading
          art={
            <StepSpot tone="success">
              <IconCircleCheck size={26} aria-hidden />
            </StepSpot>
          }
          title="Your trial is live"
          subtitle="No charge until it ends. Cancel anytime from your account."
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
          title="Finish in your browser"
          subtitle={
            checkout.usedPortalFallback
              ? "We opened your account portal. Start your free trial there."
              : "June will notice the moment you're done."
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
        art={
          <StepSpot>
            <IconGift1 size={26} aria-hidden />
          </StepSpot>
        }
        title="Try June free"
        subtitle="Dictation, meeting notes, and the agent, all on one membership."
      />
      <ol className="onboarding-timeline">
        {TRIAL_TIMELINE.map((item) => (
          <li key={item.title}>
            <h2>{item.title}</h2>
            <p>{item.body}</p>
          </li>
        ))}
      </ol>
      <p className="onboarding-footnote">
        Checkout opens in your browser. June picks up the moment you're done.
      </p>
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
