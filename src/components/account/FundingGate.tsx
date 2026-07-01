import { useEffect, useState } from "react";
import { hasLiveSubscription } from "../../lib/account-gate";
import { osAccountsOpenPortal, osAccountsUpgrade } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";
import { Spinner } from "../ui/Spinner";
import { JuneMark } from "./AccountGate";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onSignOut: () => void;
};

const POLL_INTERVAL_MS = 10_000;

export function FundingGate({ account, onRefresh, onSignOut }: Props) {
  const [openedPortal, setOpenedPortal] = useState(false);
  const [checking, setChecking] = useState(false);
  const [portalError, setPortalError] = useState<string>();
  const handle = account.user?.handle;
  const status = account.subscription?.status;
  const subscribed = account.subscription?.subscribed === true;
  const credits = account.balance?.credits;
  const negativeBalance = typeof credits === "number" && credits < 0;
  const billingRecovery =
    subscribed && typeof status === "string" && status.length > 0 && !hasLiveSubscription(account);
  const topUpRequired = subscribed && !billingRecovery && negativeBalance;

  const copy = billingRecovery
    ? {
        title: "Update billing",
        subtitle: "Your payment needs attention. Update billing to keep using June.",
        cta: "Manage billing",
        waiting: "Waiting for your billing update",
        reopen: "Reopen billing",
      }
    : topUpRequired
      ? {
          title: "Top up credits",
          subtitle: "Your credit balance is below zero. Top up credits to keep using June.",
          cta: "Top up credits",
          waiting: "Waiting for your top-up",
          reopen: "Reopen account portal",
        }
      : {
          title: "Upgrade to continue",
          subtitle: "Your starter credits are used up. Upgrade to a paid plan to keep using June.",
          cta: "Upgrade",
          waiting: "Waiting for your upgrade",
          reopen: "Reopen checkout",
        };

  useEffect(() => {
    const interval = window.setInterval(() => {
      void onRefresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [onRefresh]);

  async function handleOpenPortal() {
    setPortalError(undefined);
    try {
      if (billingRecovery || topUpRequired) {
        await osAccountsOpenPortal();
      } else {
        await osAccountsUpgrade();
      }
      setOpenedPortal(true);
    } catch (error) {
      setPortalError(messageFromError(error));
    }
  }

  async function handleCheckNow() {
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-card wide-card">
        <span className="welcome-mark" aria-hidden>
          <JuneMark />
        </span>
        <h1 className="welcome-title">{copy.title}</h1>
        <p className="welcome-subtitle">{copy.subtitle}</p>

        <div className="welcome-providers">
          {openedPortal ? (
            <>
              <div className="welcome-auth-progress" role="status" aria-live="polite">
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
                  {checking ? "Checking..." : "Check again"}
                </button>
              </div>
              <p className="funding-hint">
                Nothing happening?{" "}
                <button
                  type="button"
                  className="funding-gate-link"
                  onClick={() => void handleOpenPortal()}
                >
                  {copy.reopen}
                </button>
              </p>
            </>
          ) : (
            <button
              type="button"
              className="primary-action"
              onClick={() => void handleOpenPortal()}
            >
              {copy.cta}
            </button>
          )}
        </div>

        {portalError ? <p className="welcome-status">{portalError}</p> : null}

        <p className="welcome-terms">
          {handle ? <>Signed in as @{handle}. </> : null}
          <button type="button" className="funding-gate-link" onClick={onSignOut}>
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
