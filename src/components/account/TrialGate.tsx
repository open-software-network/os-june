import { useEffect, useState } from "react";
import { osAccountsOpenPortal } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onSignOut: () => void;
};

// The account hook already refreshes on window focus, which covers the
// common "came back from the portal" path; this poll is the fallback for
// the portal-in-another-window case where focus never returns here.
const POLL_INTERVAL_MS = 10_000;

/** Signed in but not a member: the app stays unusable until the user is on a
 * subscription (trialing or active) — credits alone don't grant access. The
 * trial flow — Stripe Checkout with card capture — lives in the accounts
 * portal, so this gate hands off to the browser and watches for the
 * subscription to become active. */
export function TrialGate({ account, onRefresh, onSignOut }: Props) {
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string>();
  // No fallback: portalUrl mirrors this build's accounts_url, and a hardcoded
  // production URL would silently send dev/staging builds to the prod portal.
  // Presence only gates the button; the actual navigation goes through Rust
  // (os_accounts_open_portal) because the webview swallows _blank anchors.
  const portalUrl = account.portalUrl;
  const handle = account.user?.handle;
  const pastDue = account.subscription?.status === "past_due";

  async function handleOpenPortal() {
    setStatus(undefined);
    try {
      await osAccountsOpenPortal();
      setStatus("Opened your account portal in the browser.");
    } catch (error) {
      setStatus(messageFromError(error));
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
      <div className="welcome-card">
        <h1 className="welcome-title">
          {pastDue ? "Payment needed" : "Start your free trial"}
        </h1>
        <p className="welcome-subtitle">
          {pastDue
            ? "Your subscription payment didn't go through. Update your billing details to keep using June."
            : "June runs on your OpenSoftware account. Start the free trial in your account portal — no charge until the trial ends."}
        </p>

        <div className="welcome-providers">
          {portalUrl ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => void handleOpenPortal()}
            >
              {pastDue ? "Manage billing" : "Start free trial"}
            </button>
          ) : (
            <p className="welcome-status welcome-status-info">
              The accounts portal is not configured for this build.
            </p>
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

        {status ? <p className="welcome-status">{status}</p> : null}

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
