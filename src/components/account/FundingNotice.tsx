import { IconChevronTopSmall } from "central-icons/IconChevronTopSmall";
import { useEffect, useRef, useState } from "react";
import { hasLiveSubscription, isOnMaxPlan } from "../../lib/account-gate";
import type { TextFundingModelContext } from "../../lib/account-gate";
import { errorCode } from "../../lib/errors";
import { AUTO_MODEL_ID } from "../../lib/agent-model-selection";
import {
  MAX_GRANT_HOSTED_POLL_TIMEOUT_MS,
  MAX_UPGRADE_BROWSER_STATUS,
  MAX_UPGRADE_BUSY_LABEL,
  MAX_UPGRADE_CHARGE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_LABEL,
  MAX_UPGRADE_CONFIRM_TITLE,
  MAX_UPGRADE_PORTAL_LABEL,
  MAX_UPGRADE_WAITING_STATUS,
  accountLooksPreGrant,
  beginMaxGrantWait,
  clearMaxGrantWait,
  isHostedMaxUpgradeFallbackError,
  isMaxGrantWaitCurrent,
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

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  /** Active composer context. Only chat placements supply it; other funding
   * surfaces keep the general account copy and action. */
  textFundingContext?: TextFundingNoticeContext;
  /** False parks the notice's account poll (the chip keeps its collapsed
   * notice mounted for the height animation; only the expanded one should
   * poll). Defaults to true. */
  active?: boolean;
};

export type TextFundingNoticeContext = TextFundingModelContext & {
  onSelectVeniceModel: () => void;
};

const POLL_INTERVAL_MS = 10_000;

type NoticeCopy = {
  body: string;
  cta: string;
  /** Copy for the waiting-on-the-portal row. Absent on the Pro upgrade
   * path, whose waiting states derive from the shared grant wait's phase
   * instead of the openedPortal flag. */
  waiting?: string;
  reopen?: string;
};

export type FundingTier = "free" | "pro" | "max";

/** The plan the user is ON — funding surfaces show their own (depleted) card,
 * never the plan being sold; the CTA copy carries the offer. */
export function fundingTierOf(account: AccountStatus): FundingTier {
  if (account.subscription?.subscribed !== true) return "free";
  return isOnMaxPlan(account) ? "max" : "pro";
}

/** The branch derivation shared by the notice and the sidebar chip so their
 * copy and tier card can never disagree. */
function deriveFunding(account: AccountStatus) {
  const status = account.subscription?.status;
  const subscribed = account.subscription?.subscribed === true;
  const credits = account.balance?.credits;
  const negativeBalance = typeof credits === "number" && credits < 0;
  const billingRecovery =
    subscribed && typeof status === "string" && status.length > 0 && !hasLiveSubscription(account);
  const topUpRequired = subscribed && !billingRecovery && negativeBalance;
  // Only Max may buy credits. A depleted Pro subscriber's one path is an
  // upgrade of the existing subscription to Max (a hosted Stripe review in
  // the browser, with a PATCH fallback behind its own charge-now confirm); a
  // depleted Max subscriber tops up through the portal as before.
  const proUpgradeRequired = topUpRequired && !isOnMaxPlan(account);
  const maxTopUpRequired = topUpRequired && isOnMaxPlan(account);
  return {
    billingRecovery,
    topUpRequired,
    proUpgradeRequired,
    maxTopUpRequired,
    tier: fundingTierOf(account),
  };
}

const TIER_LABELS: Record<FundingTier, string> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
};

/** Miniature of the OS Accounts portal's engraved-metal tier card (the
 * portal renders it at bank-card size with a WebGL mark; this is the
 * CSS-only slab at glyph scale). Decorative — the adjacent text carries the
 * meaning. Shared by every credits surface (notice, chip, failed-note
 * banner, in-transcript stopped-turn card). */
export function TierMiniCard({ tier }: { tier: FundingTier }) {
  return (
    <span className="funding-tier-card" data-tier={tier} aria-hidden>
      {TIER_LABELS[tier]}
    </span>
  );
}

/** The persistent out-of-credits surface: a compact, non-dismissible notice
 * docked where credit-consuming actions live (above the chat composers, in
 * the sidebar chip's popover). Enforcement happens at the action layer in
 * App; this row only explains the state and offers the applicable recovery.
 * Owns the checkout / billing / in-place-upgrade logic that FundingGate used
 * to hold so every placement stays behaviorally identical. */
export function FundingNotice({ account, onRefresh, textFundingContext, active = true }: Props) {
  const [openedPortal, setOpenedPortal] = useState(false);
  const [checking, setChecking] = useState(false);
  // The Max upgrade can end in a saved-card charge, so it only fires from an
  // explicit confirm dialog.
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  // Whether the confirm dialog has switched to the PATCH transport's
  // charge-now copy after a hosted capability signal. The next confirm under
  // that copy is what authorizes the saved-card charge.
  const [chargeNowUpgrade, setChargeNowUpgrade] = useState(false);
  // The notice renders in several placements at once (composer, editor
  // footer, sidebar chip), so the upgrade wait is read from the shared
  // module record on every render rather than mirrored into local state -
  // every instance stays coherent with an upgrade started anywhere. The
  // revision counter forces a re-render after in-place phase mutations.
  const [, setMaxGrantPhaseRevision] = useState(0);
  const maxGrantWait = maxGrantWaitForAccount(account.user?.id);
  const awaitingBrowser = maxGrantWait?.phase === "browser";
  const awaitingGrant = maxGrantWait?.phase === "waiting";
  const grantNotConfirmed = maxGrantWait?.phase === "slow";
  const [portalError, setPortalError] = useState<string>();
  // Remembered so "Reopen checkout" lands on the same plan the user picked.
  const [chosenPlan, setChosenPlan] = useState<SubscriptionPlan>("pro");
  const { billingRecovery, topUpRequired, proUpgradeRequired, maxTopUpRequired, tier } =
    deriveFunding(account);

  const copy: NoticeCopy = billingRecovery
    ? {
        body: "Your payment needs attention. Update billing to keep using June.",
        cta: "Manage billing",
        waiting: "Waiting for your billing update",
        reopen: "Reopen billing",
      }
    : proUpgradeRequired
      ? {
          // No waiting/reopen copy: the in-place upgrade never opens the
          // browser (openedPortal stays false). Failures show inside the
          // confirm dialog, which stays open as the retry affordance.
          body: "You have used your Pro credits for this cycle. Max has 5x the monthly usage.",
          cta: "Upgrade to Max",
        }
      : maxTopUpRequired
        ? {
            body: "Your credit balance is below zero. Top up to keep using June.",
            cta: "Top up credits",
            waiting: "Waiting for your top-up",
            reopen: "Reopen account portal",
          }
        : {
            body: "Your starter credits are used up. Upgrade to keep using June.",
            cta: "Upgrade to Pro",
            waiting: "Waiting for your upgrade",
            reopen: "Reopen checkout",
          };
  // The Max upsell only belongs on the Free/subscribe path; a depleted Pro
  // user already has exactly one path (upgrade to Max), and depleted Max
  // users top up. Neither shows a second affordance.
  const offerMaxPlan = !billingRecovery && !topUpRequired;

  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => {
      void onRefresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [onRefresh, active]);

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

  // Hosted Pro -> Max upgrade, run from the confirm dialog only. When this
  // OS Accounts deploy cannot host the browser flow, the dialog switches to
  // the charge-now copy and the PATCH waits for one more explicit confirm -
  // hosted-copy consent never authorizes a saved-card charge. Either
  // transport can expose Max before credits land, so the grant poll is the
  // only authority for lifting the wait; the notice then re-derives (or
  // lifts entirely via App's refresh). Real failures rethrow so the dialog
  // stays open showing the error next to its retry affordance.
  async function handleUpgradeToMax() {
    // A wait can begin on a coexisting surface while this confirm sits open
    // (Billing settings, another notice placement). Never stack a second
    // purchase on it; resolving without dispatch closes the dialog and the
    // notice re-derives the waiting row from the shared record. A slow wait
    // stays retryable - the dispatch below supersedes it.
    const pendingWait = maxGrantWaitForAccount(account.user?.id);
    if (pendingWait && pendingWait.phase !== "slow") {
      setMaxGrantPhaseRevision((revision) => revision + 1);
      return;
    }
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
        // Stale snapshot: the server disagrees about the current plan.
        // Refresh and let the notice re-derive the right prompt.
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
      // could never succeed and the notice must re-derive its prompt.
      const refreshed = await onRefresh();
      if (!accountLooksPreGrant(refreshed, baselineCredits)) {
        // Settled: any wait for this account is obsolete and must not keep
        // suppressing the re-derived prompt. A retry dispatched from the
        // slow phase lands here.
        const staleWait = maxGrantWaitForAccount(account.user?.id);
        if (staleWait) clearMaxGrantWait(staleWait);
        setMaxGrantPhaseRevision((revision) => revision + 1);
        return;
      }
    }
    const hostedReview = !chargeNow && !alreadyOnPlan;
    const grantWait = beginMaxGrantWait(
      baselineCredits,
      account.user?.id,
      hostedReview ? "browser" : "waiting",
    );
    setMaxGrantPhaseRevision((revision) => revision + 1);
    // No separate refresh here: the poll's first tick refreshes immediately,
    // and a parallel request could resolve out of order and overwrite the
    // poll's fresher snapshot with a stale pre-grant one.
    void pollForMaxGrant(
      onRefresh,
      baselineCredits,
      hostedReview ? { timeoutMs: MAX_GRANT_HOSTED_POLL_TIMEOUT_MS } : {},
    ).then((landed) => {
      if (!isMaxGrantWaitCurrent(grantWait)) return;
      if (landed) {
        // The poll's refresh already lifted or re-derived the notice.
        clearMaxGrantWait(grantWait);
      } else {
        // Non-terminal: the user may still be reviewing the Stripe page.
        // The slow phase keeps the retry CTA rendered.
        markMaxGrantWaitSlow(grantWait);
      }
      setMaxGrantPhaseRevision((revision) => revision + 1);
    });
  }

  // The shared wait's lifecycle against account snapshots: waits belong to
  // one account, the browser phase resolves once the plan flips, and the
  // landed grant clears the wait so the notice re-derives.
  useEffect(() => {
    if (!maxGrantWait) return;
    if (maxGrantWait.phase === "browser" && account.subscription?.plan === "max") {
      markMaxGrantWaitWaiting(maxGrantWait);
      setMaxGrantPhaseRevision((revision) => revision + 1);
    }
    if (!maxGrantLanded(account, maxGrantWait.baselineCredits)) return;
    clearMaxGrantWait(maxGrantWait);
    setMaxGrantPhaseRevision((revision) => revision + 1);
  }, [account, maxGrantWait]);

  // Closing the Stripe page must not park the notice on a spinner for the
  // whole poll window. But the browser phase is exactly when a payment can
  // complete out of band, and the wait is the only signal suppressing
  // pre-grant "Max" claims - so cancel refreshes once and clears the wait
  // only when the snapshot does not show a confirmed-but-ungranted upgrade.
  async function handleCancelBrowserWait() {
    const wait = maxGrantWait;
    if (!wait) return;
    let refreshed: AccountStatus | undefined;
    try {
      refreshed = await onRefresh();
    } catch {
      // A failed refresh cannot prove the payment went through; honor the
      // cancel with the snapshot already on hand.
    }
    if (!isMaxGrantWaitCurrent(wait)) {
      setMaxGrantPhaseRevision((revision) => revision + 1);
      return;
    }
    const snapshot = refreshed ?? account;
    if (snapshot.subscription?.plan === "max" && !maxGrantLanded(snapshot, wait.baselineCredits)) {
      // Payment confirmed, grant still on its way: keep waiting instead of
      // re-deriving a prompt that could sell a second billing action.
      markMaxGrantWaitWaiting(wait);
    } else {
      clearMaxGrantWait(wait);
    }
    setMaxGrantPhaseRevision((revision) => revision + 1);
  }

  async function handleCheckNow() {
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  }

  // The slow phase's billing link opens the account portal directly (its
  // failures land in the always-rendered portalError line); it never flips
  // the notice into the openedPortal waiting row.
  async function handleOpenBilling() {
    setPortalError(undefined);
    try {
      await osAccountsOpenPortal();
    } catch (error) {
      setPortalError(messageFromError(error));
    }
  }

  const upgradePending = awaitingBrowser || awaitingGrant;
  const waiting = upgradePending || openedPortal;
  const autoVeniceRecovery = Boolean(
    textFundingContext?.veniceApiKeyConfigured &&
      textFundingContext.activeModelId === AUTO_MODEL_ID,
  );

  function handlePrimaryFundingAction() {
    if (proUpgradeRequired) {
      setConfirmError(undefined);
      setChargeNowUpgrade(false);
      setConfirmingUpgrade(true);
      return;
    }
    void handleOpenPortal(offerMaxPlan ? "pro" : chosenPlan);
  }

  return (
    <section className="funding-notice" role="status" aria-live="polite">
      <span className="funding-notice-icon" aria-hidden>
        {waiting ? <Spinner className="funding-notice-spinner" /> : <TierMiniCard tier={tier} />}
      </span>
      <p className="funding-notice-body">
        {awaitingBrowser
          ? MAX_UPGRADE_BROWSER_STATUS
          : awaitingGrant
            ? MAX_UPGRADE_WAITING_STATUS
            : grantNotConfirmed && maxGrantWait
              ? maxUpgradeSlowStatus(maxGrantWait)
              : openedPortal
                ? copy.waiting
                : autoVeniceRecovery
                  ? "Auto can route beyond Venice, so it uses June credits. Your Venice API key applies only when you select a Venice model."
                  : copy.body}
      </p>
      <div className="funding-notice-actions">
        {upgradePending ? (
          <>
            {awaitingBrowser ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleCancelBrowserWait()}
              >
                I closed the Stripe page
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={checking}
              onClick={() => void handleCheckNow()}
            >
              {checking ? "Checking..." : "Check again"}
            </button>
          </>
        ) : grantNotConfirmed ? (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void handleOpenBilling()}
            >
              {MAX_UPGRADE_PORTAL_LABEL}
            </button>
            <button
              type="button"
              className="btn btn-secondary funding-notice-cta"
              onClick={() => {
                setConfirmError(undefined);
                setChargeNowUpgrade(false);
                setConfirmingUpgrade(true);
              }}
            >
              Upgrade to Max
            </button>
          </>
        ) : openedPortal ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => void handleOpenPortal()}>
              {copy.reopen}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={checking}
              onClick={() => void handleCheckNow()}
            >
              {checking ? "Checking..." : "Check again"}
            </button>
          </>
        ) : autoVeniceRecovery ? (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={textFundingContext?.onSelectVeniceModel}
            >
              Select a Venice model
            </button>
            <button
              type="button"
              className="btn btn-secondary funding-notice-cta"
              onClick={handlePrimaryFundingAction}
            >
              {copy.cta}
            </button>
          </>
        ) : (
          <>
            {offerMaxPlan ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleOpenPortal("max")}
              >
                Or go Max
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary funding-notice-cta"
              onClick={handlePrimaryFundingAction}
            >
              {copy.cta}
            </button>
          </>
        )}
      </div>
      {portalError ? <p className="funding-notice-error">{portalError}</p> : null}
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
    </section>
  );
}

/** Sidebar-footer presence for the out-of-credits state: a card row in the
 * update-hub family (tier card + title + hint + chevron) that expands in
 * place to reveal the same FundingNotice, so the state stays discoverable
 * from the notes views where no composer is on screen. The reveal stays
 * mounted while collapsed (visibility + inert handle focus and a11y) so the
 * grid-rows height animation runs both ways. */
export function FundingChip({ account, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { billingRecovery, tier } = deriveFunding(account);
  // One line only: a hint would truncate at sidebar widths and repeat what
  // the reveal says anyway. The title names the state; expanding explains.
  const title = billingRecovery ? "Payment needs attention" : "Out of credits";

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && wrapRef.current?.contains(target)) return;
      // The notice's Max-upgrade confirm renders in a portal over the app;
      // clicks inside it must not tear down the popover that owns it.
      if (target instanceof Element && target.closest(".dialog-backdrop")) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // An open dialog owns Escape (closing itself); the popover only closes
      // when it is the topmost layer.
      if (document.querySelector(".dialog-backdrop")) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="funding-chip-wrap" ref={wrapRef} data-expanded={open || undefined}>
      <button
        type="button"
        className="funding-chip"
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <TierMiniCard tier={tier} />
        <span className="funding-chip-title">{title}</span>
        <IconChevronTopSmall className="funding-chip-arrow" size={16} aria-hidden />
      </button>
      <div
        className="funding-chip-reveal"
        // Collapsed content must be unreachable (focus, clicks, readers)
        // while staying in the DOM for the height animation. React 18 has no
        // typed `inert` prop; the empty-string attribute is the standard
        // pass-through.
        {...(open ? {} : ({ inert: "" } as Record<string, string>))}
      >
        <div className="funding-chip-reveal-inner">
          <FundingNotice account={account} onRefresh={onRefresh} active={open} />
        </div>
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
