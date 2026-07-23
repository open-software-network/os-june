import { useCallback, useEffect } from "react";
import { messageFromError } from "../lib/errors";
import { depletedBalanceAction } from "../lib/account-gate";
import { type DepletedBalanceOutcome, runDepletedBalanceAction } from "../lib/billing-actions";
import {
  MAX_GRANT_HOSTED_POLL_TIMEOUT_MS,
  MAX_UPGRADE_BROWSER_STATUS,
  MAX_UPGRADE_READY_STATUS,
  MAX_UPGRADE_STALE_ACTION_NOTICE,
  MAX_UPGRADE_WAITING_STATUS,
  accountLooksPreGrant,
  beginMaxGrantWait,
  clearMaxGrantWait,
  isMaxGrantWaitCurrent,
  isMaxUpgradeWaitStatus,
  markMaxGrantWaitSlow,
  markMaxGrantWaitWaiting,
  maxGrantLanded,
  maxGrantWaitForAccount,
  maxUpgradeSlowStatus,
  maxUpgradeWaitStatus,
  pollForMaxGrant,
} from "../lib/max-upgrade";
import type { UseAccountActionsDependencies } from "./use-account-actions-types";

export function useAccountActions(dependencies: UseAccountActionsDependencies) {
  const {
    account,
    appMaxGrantWaitRef,
    billingNoticeTimerRef,
    maxUpgradePrompt,
    refreshAccount,
    setBillingNotice,
    setError,
    setMaxUpgradeError,
    setMaxUpgradePrompt,
    showBillingNotice,
  } = dependencies;

  const confirmMaxUpgrade = useCallback(async () => {
    if (!maxUpgradePrompt) return;
    // A wait can begin on another surface while this dialog sits open (an
    // upgrade confirmed in Billing settings). Never stack a second purchase
    // on it; adopt the wait and show its status. A slow wait stays
    // retryable - the dispatch below supersedes it.
    const pendingWait = maxGrantWaitForAccount(account.user?.id);
    if (pendingWait && pendingWait.phase !== "slow") {
      setMaxUpgradePrompt(null);
      appMaxGrantWaitRef.current = pendingWait;
      showBillingNotice(
        pendingWait.phase === "browser" ? MAX_UPGRADE_BROWSER_STATUS : MAX_UPGRADE_WAITING_STATUS,
      );
      return;
    }
    if (depletedBalanceAction(account) !== maxUpgradePrompt.action) {
      // The account reclassified between click and confirm (plan changed,
      // subscription lapsed). Never dispatch the stale intent - and never
      // just vanish: say why the dialog closed.
      setMaxUpgradePrompt(null);
      showBillingNotice(MAX_UPGRADE_STALE_ACTION_NOTICE, 8000);
      return;
    }
    const baselineCredits = account.balance?.credits ?? 0;
    let outcome: DepletedBalanceOutcome;
    try {
      outcome = await runDepletedBalanceAction(
        account,
        maxUpgradePrompt.action,
        maxUpgradePrompt.plan,
        maxUpgradePrompt.transport,
      );
    } catch (err) {
      // Keep the dialog open with the failure inside it, next to retry.
      setMaxUpgradeError(messageFromError(err));
      throw err;
    }
    if (outcome === "charge_confirmation_required") {
      // Definitive capability signal: nothing was charged. Swap the dialog to
      // the charge-now copy and keep it open (ConfirmDialog stays up on a
      // rejection) so the PATCH gets its own explicit confirm.
      setMaxUpgradeError(undefined);
      setMaxUpgradePrompt({ ...maxUpgradePrompt, transport: "charge_now" });
      throw new Error("charge_confirmation_required");
    }
    if (outcome === "already_on_plan") {
      // The server already has the plan. One refresh decides between a grant
      // still landing (poll) and a long-settled Max account, where a poll
      // could never succeed and the surface must re-derive its prompt.
      const refreshed = await refreshAccount();
      if (!accountLooksPreGrant(refreshed, baselineCredits)) {
        // Settled: any wait for this account is obsolete and must not keep
        // suppressing the depleted-balance surfaces. A retry dispatched from
        // a slow wait lands here.
        const staleWait = maxGrantWaitForAccount(account.user?.id);
        if (staleWait) clearMaxGrantWait(staleWait);
        appMaxGrantWaitRef.current = undefined;
        window.clearTimeout(billingNoticeTimerRef.current);
        setBillingNotice(null);
        return;
      }
    } else if (outcome !== "opened_upgrade_session" && outcome !== "changed_plan") {
      // The server no longer sees an active subscription. Refresh and let
      // the depleted-balance surface render the correct subscribe action.
      void refreshAccount();
      return;
    }
    // Hosted confirmation and the credit grant arrive asynchronously. The
    // consented PATCH skips only the browser-confirmation phase; both paths
    // stay neutral until the account refresh poll observes landed credits.
    const hostedReview = outcome === "opened_upgrade_session";
    const grantWait = beginMaxGrantWait(
      baselineCredits,
      account.user?.id,
      hostedReview ? "browser" : "waiting",
    );
    appMaxGrantWaitRef.current = grantWait;
    showBillingNotice(hostedReview ? MAX_UPGRADE_BROWSER_STATUS : MAX_UPGRADE_WAITING_STATUS);
    void pollForMaxGrant(
      refreshAccount,
      baselineCredits,
      hostedReview ? { timeoutMs: MAX_GRANT_HOSTED_POLL_TIMEOUT_MS } : {},
    ).then((landed) => {
      if (!isMaxGrantWaitCurrent(grantWait)) return;
      if (landed) {
        clearMaxGrantWait(grantWait);
        appMaxGrantWaitRef.current = undefined;
        showBillingNotice(MAX_UPGRADE_READY_STATUS, 8000);
      } else {
        markMaxGrantWaitSlow(grantWait);
        showBillingNotice(maxUpgradeSlowStatus(grantWait));
      }
    });
  }, [account, maxUpgradePrompt, refreshAccount, showBillingNotice]);

  useEffect(() => {
    const grantWait = appMaxGrantWaitRef.current;
    if (grantWait && grantWait.accountId !== account.user?.id) {
      clearMaxGrantWait(grantWait);
      appMaxGrantWaitRef.current = undefined;
      window.clearTimeout(billingNoticeTimerRef.current);
      setBillingNotice(null);
      return;
    }
    if (grantWait && !isMaxGrantWaitCurrent(grantWait)) {
      // Cancelled or superseded on a coexisting surface (funding notice,
      // sidebar chip, Billing settings). Drop the cached copy so the banner
      // cannot claim a wait that no longer exists; the surface owning the
      // live wait shows its status, and interaction guards re-adopt it here.
      appMaxGrantWaitRef.current = undefined;
      window.clearTimeout(billingNoticeTimerRef.current);
      setBillingNotice(null);
      return;
    }
    if (grantWait) {
      // A coexisting surface's poll advances the shared wait's phase by
      // in-place mutation, which the identity checks above cannot see. Swap
      // a stale phase line for the live one - and only a phase line, never
      // an error or the ready notice.
      const phaseCopy = maxUpgradeWaitStatus(grantWait);
      setBillingNotice((notice) =>
        notice !== null && notice !== phaseCopy && isMaxUpgradeWaitStatus(notice)
          ? phaseCopy
          : notice,
      );
    }
    if (grantWait?.phase === "browser" && account.subscription?.plan === "max") {
      markMaxGrantWaitWaiting(grantWait);
      showBillingNotice(MAX_UPGRADE_WAITING_STATUS);
    }
    if (!grantWait || !maxGrantLanded(account, grantWait.baselineCredits)) return;
    clearMaxGrantWait(grantWait);
    appMaxGrantWaitRef.current = undefined;
    showBillingNotice(MAX_UPGRADE_READY_STATUS, 8000);
  }, [account, showBillingNotice]);

  const handleTopUp = useCallback(() => {
    // An upgrade already waiting for this account (started here or on any
    // other surface) must never be offered a second purchase: adopt the wait
    // and re-show its status instead of opening a new confirm. A slow wait
    // (an abandoned Stripe page) keeps the retry path - reopening a hosted
    // session charges nothing until the Stripe confirm.
    const pendingWait = maxGrantWaitForAccount(account.user?.id);
    if (pendingWait && pendingWait.phase !== "slow") {
      appMaxGrantWaitRef.current = pendingWait;
      showBillingNotice(
        pendingWait.phase === "browser" ? MAX_UPGRADE_BROWSER_STATUS : MAX_UPGRADE_WAITING_STATUS,
      );
      return;
    }
    // Tier-aware: Max tops up, Pro changes its plan in place, Free subscribes.
    // The Max path routes through an explicit confirmation. A stale top-up
    // gate refreshes the snapshot so the surface can render the right prompt
    // without an automatic purchase.
    const action = depletedBalanceAction(account);
    if (action === "upgrade_to_max") {
      setMaxUpgradeError(undefined);
      setMaxUpgradePrompt({ action, plan: "max", transport: "hosted" });
      return;
    }
    runDepletedBalanceAction(account)
      .then((outcome) => {
        if (outcome !== "opened_browser") void refreshAccount();
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [account, refreshAccount, showBillingNotice]);

  return {
    confirmMaxUpgrade,
    handleTopUp,
  };
}
