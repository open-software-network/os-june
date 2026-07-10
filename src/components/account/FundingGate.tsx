import { useCallback, useEffect, useRef, useState } from "react";
import { hasLiveSubscription, isOnMaxPlan } from "../../lib/account-gate";
import { errorCode } from "../../lib/errors";
import {
  MAX_UPGRADE_BUSY_LABEL,
  MAX_UPGRADE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_LABEL,
  MAX_UPGRADE_CONFIRM_TITLE,
  pollForMaxGrant,
} from "../../lib/max-upgrade";
import { osAccountsChangePlan, osAccountsOpenPortal, osAccountsUpgrade } from "../../lib/tauri";
import type { AccountStatus, SubscriptionPlan } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { InlineNotice } from "../ui/InlineNotice";
import { Spinner } from "../ui/Spinner";
import { JuneMark } from "./AccountGate";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onSignOut: () => void;
  presentation?: "page" | "dialog" | "banner";
  onConfirmationOpenChange?: (open: boolean, close: () => void) => void;
};

type FundingGateDialogProps = Omit<Props, "presentation"> & {
  onDismiss: () => void;
};

type FundingGateBannerProps = Omit<Props, "presentation" | "onConfirmationOpenChange">;

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

export function FundingGate({
  account,
  onRefresh,
  onSignOut,
  presentation = "page",
  onConfirmationOpenChange,
}: Props) {
  const [openedPortal, setOpenedPortal] = useState(false);
  const [checking, setChecking] = useState(false);
  // Upgrade to Max charges the saved card the moment it runs, so it only
  // fires from an explicit confirm dialog.
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  // True after a successful plan change while the webhook credit grant is
  // still on its way; the gate lifts (via App's refresh) once it lands.
  const [awaitingGrant, setAwaitingGrant] = useState(false);
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

  // The waiting state wins over branch derivation: right after the plan
  // change PATCH the snapshot reads "depleted Max" (plan flipped, webhook
  // grant still pending), which would otherwise re-derive as the top-up
  // prompt mid-upgrade.
  const copy: GateCopy = awaitingGrant
    ? {
        title: "Setting up Max",
        subtitle: "Your upgrade went through. Your new credits are on the way.",
        cta: "",
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
            // No waiting/reopen copy: the in-place upgrade never opens the
            // browser (openedPortal stays false). Failures show inside the
            // confirm dialog, which stays open as the retry affordance.
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

  useEffect(() => {
    onConfirmationOpenChange?.(confirmingUpgrade, () => setConfirmingUpgrade(false));
  }, [confirmingUpgrade, onConfirmationOpenChange]);

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

  // In-place Pro -> Max upgrade, run from the confirm dialog only. The PATCH
  // resolves before the webhook grants the new credits, so on success the
  // gate flips to a waiting panel and polls until the balance reflects Max;
  // App's refresh then lifts the gate. Real failures rethrow so the dialog
  // stays open showing the error next to its retry affordance.
  async function handleUpgradeToMax() {
    const baselineCredits = account.balance?.credits ?? 0;
    try {
      await osAccountsChangePlan("max");
    } catch (error) {
      const code = errorCode(error);
      if (code === "already_on_plan" || code === "subscription_required") {
        // Stale snapshot: the server disagrees about the current plan.
        // Refresh and let the gate re-derive the right prompt (top up or
        // subscribe) instead of surfacing an error.
        await onRefresh();
        return;
      }
      setConfirmError(messageFromError(error));
      throw error;
    }
    setAwaitingGrant(true);
    // No separate refresh here: the poll's first tick refreshes immediately,
    // and a parallel request could resolve out of order and overwrite the
    // poll's fresher snapshot with a stale pre-grant one.
    void pollForMaxGrant(onRefresh, baselineCredits).then(() => {
      // Landed: the poll's refresh already lifted the gate. Timed out: drop
      // back to the prompt state; the periodic refresh keeps reconciling.
      setAwaitingGrant(false);
    });
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
    <div className={`welcome-screen funding-gate funding-gate-${presentation}`}>
      <div className="welcome-card wide-card">
        <span className="welcome-mark" aria-hidden>
          <JuneMark />
        </span>
        <h1 className="welcome-title">{copy.title}</h1>
        <p className="welcome-subtitle">{copy.subtitle}</p>

        <div className="welcome-providers">
          {awaitingGrant ? (
            <div className="welcome-auth-progress" role="status" aria-live="polite">
              <span className="welcome-progress-label">
                <Spinner className="welcome-spinner" aria-hidden />
                <span>Waiting for your new credits</span>
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
          ) : proUpgradeRequired ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                setConfirmError(undefined);
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

        {portalError ? <p className="welcome-status">{portalError}</p> : null}

        <p className="welcome-terms">
          {handle ? <>Signed in as @{handle}. </> : null}
          <button type="button" className="funding-gate-link" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      </div>
      <ConfirmDialog
        open={confirmingUpgrade}
        onClose={() => setConfirmingUpgrade(false)}
        onConfirm={handleUpgradeToMax}
        title={MAX_UPGRADE_CONFIRM_TITLE}
        description={confirmError ?? MAX_UPGRADE_CONFIRM_BODY}
        confirmLabel={MAX_UPGRADE_CONFIRM_LABEL}
        confirmBusyLabel={MAX_UPGRADE_BUSY_LABEL}
      />
    </div>
  );
}

/** Dialog presentation for the existing funding content. Billing and checkout
 * behavior stays owned by FundingGate so this wrapper cannot drift from it. */
export function FundingGateDialog({ onDismiss, ...props }: FundingGateDialogProps) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const closeConfirmationRef = useRef<() => void>(() => undefined);

  const handleConfirmationOpenChange = useCallback((open: boolean, close: () => void) => {
    closeConfirmationRef.current = close;
    setConfirmationOpen(open);
  }, []);

  const dismissFundingDialog = () => {
    // FundingGate owns one nested confirmation. Close that layer first without
    // making unrelated dialogs affect this dialog's dismissal.
    if (confirmationOpen) {
      closeConfirmationRef.current();
      return;
    }
    onDismiss();
  };

  return (
    <Dialog
      open
      onClose={dismissFundingDialog}
      title="Credits needed"
      footer={
        <button type="button" className="primary-action" onClick={dismissFundingDialog}>
          Not now
        </button>
      }
    >
      <FundingGate
        {...props}
        presentation="dialog"
        onConfirmationOpenChange={handleConfirmationOpenChange}
      />
    </Dialog>
  );
}

/** Persistent shell presentation. InlineNotice owns the banner surface while
 * FundingGate continues to own all billing copy and actions. */
export function FundingGateBanner(props: FundingGateBannerProps) {
  return (
    <InlineNotice
      className="funding-gate-banner-notice"
      body={null}
      actions={<FundingGate {...props} presentation="banner" />}
    />
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
