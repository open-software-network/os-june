import { IconChevronTopSmall } from "central-icons/IconChevronTopSmall";
import { useEffect, useRef, useState } from "react";
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
import { Spinner } from "../ui/Spinner";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  /** False parks the notice's account poll (the chip keeps its collapsed
   * notice mounted for the height animation; only the expanded one should
   * poll). Defaults to true. */
  active?: boolean;
};

const POLL_INTERVAL_MS = 10_000;

type NoticeCopy = {
  body: string;
  cta: string;
  /** Copy for the waiting-on-the-browser row. Absent on the in-place Pro
   * upgrade path, which never opens the browser. */
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
  // in-place upgrade to Max (credits granted immediately, no browser round
  // trip); a depleted Max subscriber tops up through the portal as before.
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
 * App; this row only explains the state and offers the one way out of it.
 * Owns the checkout / billing / in-place-upgrade logic that FundingGate used
 * to hold so every placement stays behaviorally identical. */
export function FundingNotice({ account, onRefresh, active = true }: Props) {
  const [openedPortal, setOpenedPortal] = useState(false);
  const [checking, setChecking] = useState(false);
  // Upgrade to Max charges the saved card the moment it runs, so it only
  // fires from an explicit confirm dialog.
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  // True after a successful plan change while the webhook credit grant is
  // still on its way; the notice lifts (via App's refresh) once it lands.
  const [awaitingGrant, setAwaitingGrant] = useState(false);
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

  // In-place Pro -> Max upgrade, run from the confirm dialog only. The PATCH
  // resolves before the webhook grants the new credits, so on success the
  // notice flips to a waiting row and polls until the balance reflects Max;
  // App's refresh then lifts the notice. Real failures rethrow so the dialog
  // stays open showing the error next to its retry affordance.
  async function handleUpgradeToMax() {
    const baselineCredits = account.balance?.credits ?? 0;
    try {
      await osAccountsChangePlan("max");
    } catch (error) {
      const code = errorCode(error);
      if (code === "already_on_plan" || code === "subscription_required") {
        // Stale snapshot: the server disagrees about the current plan.
        // Refresh and let the notice re-derive the right prompt (top up or
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
      // Landed: the poll's refresh already lifted the notice. Timed out: drop
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

  const waiting = awaitingGrant || openedPortal;

  return (
    <section className="funding-notice" role="status" aria-live="polite">
      <span className="funding-notice-icon" aria-hidden>
        {waiting ? <Spinner className="funding-notice-spinner" /> : <TierMiniCard tier={tier} />}
      </span>
      <p className="funding-notice-body">
        {awaitingGrant
          ? "Your upgrade went through. Your new credits are on the way."
          : openedPortal
            ? copy.waiting
            : copy.body}
      </p>
      <div className="funding-notice-actions">
        {awaitingGrant ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={checking}
            onClick={() => void handleCheckNow()}
          >
            {checking ? "Checking..." : "Check again"}
          </button>
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
              onClick={() => {
                if (proUpgradeRequired) {
                  setConfirmError(undefined);
                  setConfirmingUpgrade(true);
                  return;
                }
                void handleOpenPortal(offerMaxPlan ? "pro" : chosenPlan);
              }}
            >
              {copy.cta}
            </button>
          </>
        )}
      </div>
      {portalError ? <p className="funding-notice-error">{portalError}</p> : null}
      <ConfirmDialog
        open={confirmingUpgrade}
        onClose={() => setConfirmingUpgrade(false)}
        onConfirm={handleUpgradeToMax}
        title={MAX_UPGRADE_CONFIRM_TITLE}
        description={confirmError ?? MAX_UPGRADE_CONFIRM_BODY}
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
