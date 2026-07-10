import { useEffect, useState } from "react";
import { hasLiveSubscription, isOnMaxPlan } from "../../lib/account-gate";
import { errorCode } from "../../lib/errors";
import {
  MAX_GRANT_HOSTED_POLL_TIMEOUT_MS,
  MAX_UPGRADE_BROWSER_STATUS,
  MAX_UPGRADE_BUSY_LABEL,
  MAX_UPGRADE_CHARGE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_LABEL,
  MAX_UPGRADE_CONFIRM_TITLE,
  MAX_UPGRADE_PORTAL_LABEL,
  MAX_UPGRADE_READY_STATUS,
  MAX_UPGRADE_SLOW_STATUS,
  MAX_UPGRADE_WAITING_STATUS,
  type MaxGrantWait,
  accountLooksPreGrant,
  beginMaxGrantWait,
  clearMaxGrantWait,
  isMaxGrantWaitCurrent,
  isHostedMaxUpgradeFallbackError,
  markMaxGrantWaitSlow,
  markMaxGrantWaitWaiting,
  maxGrantLanded,
  maxGrantWaitForAccount,
  maxUpgradeSlowStatus,
  pollForMaxGrant,
} from "../../lib/max-upgrade";
import {
  osAccountsChangePlan,
  osAccountsOpenPortal,
  osAccountsUpgrade,
  osAccountsUpgradeSession,
} from "../../lib/tauri";
import type { AccountStatus, SubscriptionPlan } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
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
  /** Copy for a browser handoff such as checkout or billing management. */
  waiting?: string;
  reopen?: string;
};

export function FundingGate({ account, onRefresh, onSignOut }: Props) {
  const [openedPortal, setOpenedPortal] = useState(false);
  const [checking, setChecking] = useState(false);
  // The existing-subscription Max upgrade starts only from an explicit confirm dialog.
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  // Whether the confirm dialog has switched to the PATCH transport's
  // charge-now copy after a hosted capability signal. The next confirm under
  // that copy is what authorizes the saved-card charge.
  const [chargeNowUpgrade, setChargeNowUpgrade] = useState(false);
  // Adopt an upgrade wait started on another surface (Billing settings, a
  // depleted-note banner) so this gate never offers a second purchase while
  // one is in flight for the same account.
  const [maxGrantWait, setMaxGrantWait] = useState<MaxGrantWait | undefined>(() =>
    maxGrantWaitForAccount(account.user?.id),
  );
  const [, setMaxGrantPhaseRevision] = useState(0);
  const awaitingBrowser = maxGrantWait?.phase === "browser";
  const awaitingGrant = maxGrantWait?.phase === "waiting";
  const upgradePending = awaitingBrowser || awaitingGrant;
  const grantNotConfirmed = maxGrantWait?.phase === "slow";
  const [billingStatus, setBillingStatus] = useState<string>();
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
  // hosted upgrade; a depleted Max subscriber tops up through the portal.
  const proUpgradeRequired = topUpRequired && !isOnMaxPlan(account);
  const maxTopUpRequired = topUpRequired && isOnMaxPlan(account);

  // This waiting state wins over branch derivation. The subscription can show
  // Max before the webhook grant arrives, which must not turn the in-flight
  // upgrade into a top-up prompt.
  const copy: GateCopy = awaitingBrowser
    ? {
        title: "Upgrade in progress",
        subtitle: MAX_UPGRADE_BROWSER_STATUS,
        cta: "",
      }
    : awaitingGrant
      ? {
          title: "Upgrade in progress",
          subtitle: MAX_UPGRADE_WAITING_STATUS,
          cta: "",
        }
      : grantNotConfirmed
        ? {
            // Non-terminal: an outlasted poll window usually means the user
            // is still on (or abandoned) the Stripe page. Retrying reopens a
            // hosted session, which charges nothing until Stripe confirm.
            title: "Waiting for payment confirmation",
            subtitle: maxGrantWait ? maxUpgradeSlowStatus(maxGrantWait) : MAX_UPGRADE_SLOW_STATUS,
            cta: "Upgrade to Max",
          }
        : billingRecovery
          ? {
              title: "Update billing",
              subtitle: "Your payment needs attention. Update billing to keep using June.",
              cta: "Manage billing",
              waiting: "Waiting for your billing update",
              reopen: "Reopen billing",
            }
          : proUpgradeRequired
            ? {
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
    setBillingStatus(undefined);
    try {
      if (billingRecovery || maxTopUpRequired) {
        await osAccountsOpenPortal();
      } else {
        setChosenPlan(plan);
        await osAccountsUpgrade(plan);
      }
      setOpenedPortal(true);
    } catch (error) {
      setBillingStatus(messageFromError(error));
    }
  }

  async function handleManageBilling() {
    try {
      await osAccountsOpenPortal();
    } catch (error) {
      setBillingStatus(messageFromError(error));
    }
  }

  // Hosted Pro -> Max upgrade, run from the confirm dialog only. When this
  // OS Accounts deploy cannot host the browser flow, the dialog switches to
  // the charge-now copy and the PATCH waits for one more explicit confirm -
  // hosted-copy consent never authorizes a saved-card charge. Either
  // transport can expose Max before credits land, so the grant poll is the
  // only authority for announcing Max.
  async function handleUpgradeToMax() {
    const baselineCredits = account.balance?.credits ?? 0;
    const chargeNow = chargeNowUpgrade;
    let alreadyOnPlan = false;
    try {
      if (chargeNow) {
        await osAccountsChangePlan("max");
      } else {
        await osAccountsUpgradeSession("max");
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === "already_on_plan") {
        alreadyOnPlan = true;
      } else if (code === "subscription_required") {
        await onRefresh();
        return;
      } else if (!chargeNow && isHostedMaxUpgradeFallbackError(error)) {
        // Definitive capability signal: nothing was charged. Swap the dialog
        // to the charge-now copy and keep it open for a fresh confirm.
        setConfirmError(undefined);
        setChargeNowUpgrade(true);
        throw error;
      } else {
        setConfirmError(messageFromError(error));
        throw error;
      }
    }
    if (alreadyOnPlan) {
      // The server already has the plan. One refresh decides between a grant
      // still landing (poll) and a long-settled Max account, where a poll
      // could never succeed and the gate must re-derive its prompt instead.
      const refreshed = await onRefresh();
      if (!accountLooksPreGrant(refreshed, baselineCredits)) return;
    }
    const hostedReview = !chargeNow && !alreadyOnPlan;
    const grantWait = beginMaxGrantWait(
      baselineCredits,
      account.user?.id,
      hostedReview ? "browser" : "waiting",
    );
    setMaxGrantWait(grantWait);
    setBillingStatus(undefined);
    void pollForMaxGrant(
      onRefresh,
      baselineCredits,
      hostedReview ? { timeoutMs: MAX_GRANT_HOSTED_POLL_TIMEOUT_MS } : {},
    ).then((landed) => {
      if (!isMaxGrantWaitCurrent(grantWait)) return;
      if (landed) {
        clearMaxGrantWait(grantWait);
        setMaxGrantWait(undefined);
      } else {
        markMaxGrantWaitSlow(grantWait);
      }
      setBillingStatus(landed ? MAX_UPGRADE_READY_STATUS : maxUpgradeSlowStatus(grantWait));
    });
  }

  useEffect(() => {
    if (!maxGrantWait) return;
    if (maxGrantWait.accountId !== account.user?.id) {
      clearMaxGrantWait(maxGrantWait);
      setMaxGrantWait(undefined);
      setBillingStatus(undefined);
      return;
    }
    if (maxGrantWait.phase === "browser" && account.subscription?.plan === "max") {
      markMaxGrantWaitWaiting(maxGrantWait);
      setMaxGrantPhaseRevision((revision) => revision + 1);
    }
    if (!maxGrantLanded(account, maxGrantWait.baselineCredits)) return;
    clearMaxGrantWait(maxGrantWait);
    setMaxGrantWait(undefined);
    setBillingStatus(MAX_UPGRADE_READY_STATUS);
  }, [account, maxGrantWait]);

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
          {upgradePending ? (
            <div className="welcome-auth-progress" role="status" aria-live="polite">
              <span className="welcome-progress-label">
                <Spinner className="welcome-spinner" aria-hidden />
                <span>
                  {awaitingBrowser
                    ? MAX_UPGRADE_BROWSER_STATUS
                    : "Waiting for payment confirmation"}
                </span>
              </span>
              <button
                type="button"
                className="welcome-cancel-btn"
                disabled={checking}
                onClick={() => void handleCheckNow()}
              >
                {checking ? "Checking..." : "Check again"}
              </button>
              {awaitingBrowser ? (
                // The browser phase means nothing has been charged yet: the
                // user is (or was) on the Stripe page. Closing that page
                // must not wall the gate for the whole poll window, so this
                // clears the wait and returns to the upgrade prompt. If the
                // payment actually went through, the focus refresh observes
                // the landed grant and unblocks anyway.
                <button
                  type="button"
                  className="welcome-cancel-btn"
                  onClick={() => {
                    if (maxGrantWait) clearMaxGrantWait(maxGrantWait);
                    setMaxGrantWait(undefined);
                    setBillingStatus(undefined);
                  }}
                >
                  I closed the Stripe page
                </button>
              ) : null}
            </div>
          ) : grantNotConfirmed || proUpgradeRequired ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                setConfirmError(undefined);
                setChargeNowUpgrade(false);
                setConfirmingUpgrade(true);
              }}
            >
              {copy.cta}
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

        {billingStatus && !grantNotConfirmed ? (
          <p className="welcome-status">{billingStatus}</p>
        ) : null}
        {grantNotConfirmed ? (
          <p className="funding-hint">
            <button
              type="button"
              className="funding-gate-link"
              onClick={() => void handleManageBilling()}
            >
              {MAX_UPGRADE_PORTAL_LABEL}
            </button>
          </p>
        ) : null}

        <p className="welcome-terms">
          {handle ? <>Signed in as @{handle}. </> : null}
          <button type="button" className="funding-gate-link" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      </div>
      <ConfirmDialog
        open={confirmingUpgrade}
        onClose={() => {
          setConfirmingUpgrade(false);
          setChargeNowUpgrade(false);
        }}
        onConfirm={handleUpgradeToMax}
        title={MAX_UPGRADE_CONFIRM_TITLE}
        description={
          confirmError ??
          (chargeNowUpgrade ? MAX_UPGRADE_CHARGE_CONFIRM_BODY : MAX_UPGRADE_CONFIRM_BODY)
        }
        confirmLabel={MAX_UPGRADE_CONFIRM_LABEL}
        confirmBusyLabel={MAX_UPGRADE_BUSY_LABEL}
      />
    </div>
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
