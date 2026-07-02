import { useEffect, useState } from "react";
import { hasLiveSubscription, isOnMaxPlan } from "../../lib/account-gate";
import { osAccountsChangePlan, osAccountsOpenPortal, osAccountsUpgrade } from "../../lib/tauri";
import type { AccountStatus, SubscriptionPlan } from "../../lib/tauri";
import { Spinner } from "../ui/Spinner";
import { JuneMark } from "./AccountGate";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onSignOut: () => void;
};

const POLL_INTERVAL_MS = 10_000;

type GateCopy = {
  title: string;
  subtitle: string;
  cta: string;
  /** Copy for the waiting-on-the-browser panel. Absent on the in-place Pro
   * upgrade path, which never opens the browser. */
  waiting?: string;
  reopen?: string;
};

export function FundingGate({ account, onRefresh, onSignOut }: Props) {
  const [openedPortal, setOpenedPortal] = useState(false);
  const [checking, setChecking] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [portalError, setPortalError] = useState<string>();
  // Remembered so "Reopen checkout" lands on the same plan the user picked.
  const [chosenPlan, setChosenPlan] = useState<SubscriptionPlan>("pro");
  const handle = account.user?.handle;
  const status = account.subscription?.status;
  const subscribed = account.subscription?.subscribed === true;
  const credits = account.balance?.credits;
  const negativeBalance = typeof credits === "number" && credits < 0;
  const billingRecovery =
    subscribed && typeof status === "string" && status.length > 0 && !hasLiveSubscription(account);
  const topUpRequired = subscribed && !billingRecovery && negativeBalance;
  // Only Max may buy credits. A depleted Pro subscriber's one path is an
  // in-place upgrade to Max (credits granted immediately, no browser round
  // trip); a depleted Max subscriber tops up through the portal as before.
  const proUpgradeRequired = topUpRequired && !isOnMaxPlan(account);
  const maxTopUpRequired = topUpRequired && isOnMaxPlan(account);

  const copy: GateCopy = billingRecovery
    ? {
        title: "Update billing",
        subtitle: "Your payment needs attention. Update billing to keep using June.",
        cta: "Manage billing",
        waiting: "Waiting for your billing update",
        reopen: "Reopen billing",
      }
    : proUpgradeRequired
      ? {
          // No waiting/reopen copy: the in-place upgrade never opens the
          // browser (openedPortal stays false), and after a failure the
          // primary CTA itself stays enabled with the error below, so it is
          // the retry affordance.
          title: "Upgrade to Max",
          subtitle:
            "You have used your Pro credits for this cycle. Upgrade to Max for 5x the monthly usage.",
          cta: "Upgrade to Max",
        }
      : maxTopUpRequired
        ? {
            title: "Top up credits",
            subtitle: "Your credit balance is below zero. Top up credits to keep using June.",
            cta: "Top up credits",
            waiting: "Waiting for your top-up",
            reopen: "Reopen account portal",
          }
        : {
            title: "Upgrade to continue",
            subtitle:
              "Your starter credits are used up. Upgrade to a paid plan to keep using June.",
            cta: "Upgrade to Pro",
            waiting: "Waiting for your upgrade",
            reopen: "Reopen checkout",
          };
  // The Max upsell link only belongs on the Free/subscribe path; a depleted Pro
  // user already has exactly one path (upgrade to Max), and depleted Max users
  // top up. Neither shows a second affordance.
  const offerMaxPlan = !billingRecovery && !topUpRequired;

  useEffect(() => {
    const interval = window.setInterval(() => {
      void onRefresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [onRefresh]);

  async function handleOpenPortal(plan: SubscriptionPlan = chosenPlan) {
    setPortalError(undefined);
    try {
      if (billingRecovery || maxTopUpRequired) {
        await osAccountsOpenPortal();
      } else {
        setChosenPlan(plan);
        await osAccountsUpgrade(plan);
      }
      setOpenedPortal(true);
    } catch (error) {
      setPortalError(messageFromError(error));
    }
  }

  // In-place Pro -> Max upgrade: OS Accounts prorates and grants Max credits
  // immediately, so there is no browser to wait on. Refresh to lift the gate.
  async function handleUpgradeToMax() {
    setPortalError(undefined);
    setUpgrading(true);
    try {
      await osAccountsChangePlan("max");
      await onRefresh();
    } catch (error) {
      setPortalError(messageFromError(error));
    } finally {
      setUpgrading(false);
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
          {proUpgradeRequired ? (
            <button
              type="button"
              className="primary-action"
              disabled={upgrading}
              onClick={() => void handleUpgradeToMax()}
            >
              {upgrading ? "Upgrading..." : copy.cta}
            </button>
          ) : openedPortal ? (
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
            <>
              <button
                type="button"
                className="primary-action"
                onClick={() => void handleOpenPortal(offerMaxPlan ? "pro" : chosenPlan)}
              >
                {copy.cta}
              </button>
              {offerMaxPlan ? (
                <p className="funding-hint">
                  Want to go beyond Pro?{" "}
                  <button
                    type="button"
                    className="funding-gate-link"
                    onClick={() => void handleOpenPortal("max")}
                  >
                    Upgrade to Max
                  </button>
                </p>
              ) : null}
            </>
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
