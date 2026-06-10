import { useEffect, useState } from "react";
import { IconUnlocked } from "central-icons/IconUnlocked";
import { IconCalendar1 } from "central-icons/IconCalendar1";
import { IconCreditCard1 } from "central-icons/IconCreditCard1";
import { osAccountsOpenPortal } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";
import { Spinner } from "../ui/Spinner";
import { JuneMark } from "./AccountGate";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onSignOut: () => void;
};

// The account hook already refreshes on window focus, which covers the
// common "came back from the portal" path; this poll is the fallback for
// the portal-in-another-window case where focus never returns here.
const POLL_INTERVAL_MS = 10_000;

// Must match trial_period_days on the Stripe price in the OS Accounts
// dashboard — the trial is configured there, not in code, and the client
// can't read it before a subscription exists, so it's pinned here.
const TRIAL_LENGTH_DAYS = 14;

const TRIAL_STEPS = [
  {
    icon: IconUnlocked,
    label: "Today",
    detail: "Full access to June — record meetings, dictate, and get polished notes.",
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
function trialEndDate() {
  const end = new Date(Date.now() + TRIAL_LENGTH_DAYS * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
  }).format(end);
}

/** Signed in but not a member: the app stays unusable until the user is on a
 * subscription (trialing or active) — credits alone don't grant access. The
 * trial flow — Stripe Checkout with card capture — lives in the accounts
 * portal, so this gate hands off to the browser and watches for the
 * subscription to become active. */
export function TrialGate({ account, onRefresh, onSignOut }: Props) {
  const [checking, setChecking] = useState(false);
  // Once the portal is open in the browser, the primary button gives way to a
  // waiting row: the poll below (plus focus refresh) picks up the new
  // subscription, and "Check now" is the impatient path.
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  // No fallback: portalUrl mirrors this build's accounts_url, and a hardcoded
  // production URL would silently send dev/staging builds to the prod portal.
  // Presence only gates the button; the actual navigation goes through Rust
  // (os_accounts_open_portal) because the webview swallows _blank anchors.
  const portalUrl = account.portalUrl;
  const handle = account.user?.handle;
  const status = account.subscription?.status;
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
            "Your subscription has ended. Resubscribe to keep using June — your notes are right where you left them.",
          cta: "Resubscribe",
          waiting: "Waiting for your subscription to start",
        }
      : {
          title: "Start your free trial",
          subtitle: "Try everything June can do — free to start, cancel anytime.",
          cta: "Start free trial",
          waiting: "Waiting for your trial to start",
        };
  // The timeline and "$0 due today" only make sense for a first trial.
  const trialPitch = !pastDue && !canceled;

  async function handleOpenPortal() {
    setError(undefined);
    try {
      await osAccountsOpenPortal();
      setWaiting(true);
    } catch (error) {
      setError(messageFromError(error));
    }
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      void onRefresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [onRefresh]);

  async function handleRefresh() {
    setChecking(true);
    try {
      await onRefresh();
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
        <h1 className="welcome-title">{copy.title}</h1>
        <p className="welcome-subtitle">{copy.subtitle}</p>

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
                          {trialEndDate()}
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
          {!portalUrl ? (
            <p className="welcome-status welcome-status-info">
              The accounts portal is not configured for this build.
            </p>
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
                  onClick={() => void handleRefresh()}
                >
                  {checking ? "Checking…" : "Check now"}
                </button>
              </div>
              <p className="trial-hint">
                Nothing happening?{" "}
                <button
                  type="button"
                  className="trial-gate-link"
                  onClick={() => void handleOpenPortal()}
                >
                  Open the portal again
                </button>
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                className="primary-action"
                onClick={() => void handleOpenPortal()}
              >
                {copy.cta}
              </button>
              {trialPitch ? (
                <p className="trial-hint">Due today: $0</p>
              ) : null}
            </>
          )}
        </div>

        {error ? <p className="welcome-status">{error}</p> : null}

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
