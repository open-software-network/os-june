import { useEffect, useState } from "react";
import { IconUnlocked } from "central-icons/IconUnlocked";
import { IconCalendar1 } from "central-icons/IconCalendar1";
import { IconCreditCard1 } from "central-icons/IconCreditCard1";
import { osAccountsOpenPortal } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";
import { useTrialCheckout } from "../../lib/trial-checkout";
import { Spinner } from "../ui/Spinner";
import { JuneMark } from "./AccountGate";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onSignOut: () => void;
};

// The account hook already refreshes on window focus, which covers the
// common "came back from the browser" path; this poll is the fallback for
// the checkout-in-another-window case where focus never returns here. The
// checkout hook layers a faster poll on top while a checkout is in flight.
const POLL_INTERVAL_MS = 10_000;

// Fallback when the accounts API doesn't report `trialPeriodDays` yet. Must
// match trial_period_days on the Stripe price in the OS Accounts dashboard —
// the trial is configured there, not in code. Once the API ships the field,
// the live value always wins and this constant is dead weight.
const FALLBACK_TRIAL_LENGTH_DAYS = 14;

const TRIAL_STEPS = [
  {
    icon: IconUnlocked,
    label: "Today",
    detail: "Full access to June: record meetings, dictate, and get polished notes.",
  },
  {
    icon: IconCalendar1,
    label: "During your trial",
    detail: "Pay nothing. Cancel anytime from your account portal.",
  },
  {
    icon: IconCreditCard1,
    label: "Your trial ends",
    detail: "Your subscription starts. No charge before then.",
    showsEndDate: true,
  },
];

/** The end date assuming the trial starts now — accurate at the moment the
 * screen is read, which is the only moment it's shown. */
function trialEndDate(trialDays: number) {
  const end = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
  // A trial started in late December ends next year; include the year so
  // the date can't read as eleven months past.
  const showYear = end.getFullYear() !== new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    ...(showYear ? { year: "numeric" } : {}),
  }).format(end);
}

/** Signed in but not a member: the app stays unusable until the user is on a
 * subscription (trialing or active) — credits alone don't grant access. This
 * gate is the post-onboarding fallback (lapsed, canceled, signed in on a new
 * machine after a wipe). One click mints the Stripe Checkout session directly
 * and opens it in the browser; the gate dissolves on its own the moment the
 * subscription appears. */
export function TrialGate({ account, onRefresh, onSignOut }: Props) {
  const [checking, setChecking] = useState(false);
  const handle = account.user?.handle;
  const status = account.subscription?.status;
  const trialDays =
    account.subscription?.trialPeriodDays ?? FALLBACK_TRIAL_LENGTH_DAYS;
  const pastDue = status === "past_due";
  // A returning canceled subscriber likely gets no second trial (that's up to
  // the Stripe checkout config), so don't promise "free" or "$0 due today".
  const canceled = status === "canceled";

  const copy = pastDue
    ? {
        title: "Payment needed",
        subtitle:
          "Your subscription payment didn't go through. Update your billing details to keep using June.",
        cta: "Manage billing",
        waiting: "Waiting for your billing update",
      }
    : canceled
      ? {
          title: "Welcome back",
          subtitle:
            "Your subscription has ended. Resubscribe to keep using June. Your notes are right where you left them.",
          cta: "Resubscribe",
          waiting: "Waiting for your subscription to start",
        }
      : {
          title: "Start your free trial",
          subtitle: "Try everything June can do. Free to start, cancel anytime.",
          cta: "Start free trial",
          waiting: "Waiting for your trial to start",
        };
  // The timeline and "$0 due today" only make sense for a first trial.
  const trialPitch = !pastDue && !canceled;

  // No onActivated work needed: App re-renders past this gate as soon as the
  // refreshed snapshot carries a live subscription.
  const checkout = useTrialCheckout({
    account,
    onRefresh,
    onActivated: () => undefined,
  });
  const waiting = checkout.phase === "waiting";

  const [portalError, setPortalError] = useState<string>();
  async function handleManageBilling() {
    setPortalError(undefined);
    try {
      await osAccountsOpenPortal();
    } catch (error) {
      setPortalError(messageFromError(error));
    }
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      void onRefresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [onRefresh]);

  async function handleCheckNow() {
    setChecking(true);
    try {
      await checkout.checkNow();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-card trial-card">
        <span className="welcome-mark" aria-hidden>
          <JuneMark />
        </span>
        <h1 className="welcome-title">
          {waiting ? "Finish checkout in your browser" : copy.title}
        </h1>
        <p className="welcome-subtitle">
          {waiting
            ? checkout.usedPortalFallback
              ? "We opened your account portal. Finish there and June will notice the moment you're done."
              : "We opened a secure Stripe checkout. June will notice the moment you're done. No need to come back and click anything."
            : copy.subtitle}
        </p>

        {trialPitch ? (
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
                        {", "}
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
        ) : null}

        <div className="welcome-providers">
          {pastDue ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => void handleManageBilling()}
            >
              {copy.cta}
            </button>
          ) : waiting ? (
            <>
              <div
                className="welcome-auth-progress"
                role="status"
                aria-live="polite"
              >
                <span className="welcome-progress-label">
                  <Spinner className="welcome-spinner" aria-hidden />
                  <span>{copy.waiting}</span>
                </span>
                <button
                  type="button"
                  className="welcome-cancel-btn"
                  disabled={checking}
                  onClick={() => void handleCheckNow()}
                >
                  {checking ? "Checking…" : "Check now"}
                </button>
              </div>
              <p className="trial-hint">
                Nothing happening?{" "}
                <button
                  type="button"
                  className="trial-gate-link"
                  onClick={() => void checkout.start()}
                >
                  Reopen checkout
                </button>
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                className="primary-action"
                disabled={
                  checkout.phase === "opening" || checkout.phase === "reauth"
                }
                onClick={() => void checkout.start()}
              >
                {checkout.phase === "reauth"
                  ? "Confirming your sign-in…"
                  : checkout.phase === "opening"
                    ? "Opening checkout…"
                    : copy.cta}
              </button>
              {trialPitch ? (
                <p className="trial-hint">Due today: $0</p>
              ) : null}
            </>
          )}
        </div>

        {checkout.error ? (
          <p className="welcome-status">{checkout.error}</p>
        ) : checkout.notice ? (
          <p className="welcome-status welcome-status-info">
            {checkout.notice}
          </p>
        ) : null}
        {portalError ? <p className="welcome-status">{portalError}</p> : null}

        <p className="welcome-terms">
          {handle ? <>Signed in as @{handle}. </> : null}
          <button
            type="button"
            className="trial-gate-link"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
