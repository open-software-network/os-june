import { useEffect, useState } from "react";
import { osAccountsOpenPortal } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";
import { useTrialCheckout } from "../../lib/trial-checkout";
import { Spinner } from "../ui/Spinner";

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

/** Signed in but not a member: the app stays unusable until the user is on a
 * subscription (trialing or active) — credits alone don't grant access. This
 * gate is the post-onboarding fallback (lapsed, canceled, signed in on a new
 * machine after a wipe). One click mints the Stripe Checkout session directly
 * and opens it in the browser; the gate dissolves on its own the moment the
 * subscription appears. */
export function TrialGate({ account, onRefresh, onSignOut }: Props) {
  const [checking, setChecking] = useState(false);
  const handle = account.user?.handle;
  const pastDue = account.subscription?.status === "past_due";

  // No onActivated work needed: App re-renders past this gate as soon as the
  // refreshed snapshot carries a live subscription.
  const checkout = useTrialCheckout({
    account,
    onRefresh,
    onActivated: () => undefined,
  });

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

  async function handleRefresh() {
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  }

  const waiting = checkout.phase === "waiting";

  return (
    <div className="welcome-screen">
      <div className="welcome-card">
        <h1 className="welcome-title">
          {pastDue
            ? "Payment needed"
            : waiting
              ? "Finish checkout in your browser"
              : "Start your free trial"}
        </h1>
        <p className="welcome-subtitle">
          {pastDue
            ? "Your subscription payment didn't go through. Update your billing details to keep using June."
            : waiting
              ? checkout.usedPortalFallback
                ? "We opened your account portal — start the free trial there. June will notice the moment you're done."
                : "We opened a secure Stripe checkout. June will notice the moment you're done — no need to come back and click anything."
              : "June runs on your OpenSoftware membership. Checkout opens in your browser — no charge until the trial ends, cancel anytime."}
        </p>

        <div className="welcome-providers">
          {pastDue ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => void handleManageBilling()}
            >
              Manage billing
            </button>
          ) : waiting ? (
            <div
              className="welcome-auth-progress"
              role="status"
              aria-live="polite"
            >
              <span className="welcome-progress-label">
                <Spinner className="welcome-spinner" aria-hidden />
                <span>Waiting for your trial to start</span>
              </span>
              <button
                type="button"
                className="welcome-cancel-btn"
                onClick={() => void checkout.start()}
              >
                Reopen checkout
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="primary-action"
              disabled={checkout.phase === "opening"}
              onClick={() => void checkout.start()}
            >
              {checkout.phase === "opening"
                ? "Opening checkout…"
                : "Start free trial"}
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary trial-gate-refresh"
            disabled={checking}
            onClick={() => void handleRefresh()}
          >
            {checking ? "Checking…" : "I've done it — check again"}
          </button>
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
            className="trial-gate-signout"
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
