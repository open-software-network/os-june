import type { AccountStatus } from "./tauri";
import { errorCode } from "./errors";

// Single source of truth for Max upgrade confirm and status copy. The plan
// change returns before payment is confirmed and the credit grant lands, so
// only the grant poll may advance the copy from waiting to active.
export const MAX_UPGRADE_CONFIRM_TITLE = "Upgrade to Max?";
export const MAX_UPGRADE_CONFIRM_BODY =
  "Max is $100 per month. A secure Stripe page will open in your browser to review and confirm. Your billing cycle restarts today.";
// The PATCH transport charges the saved card without a browser review, so it
// carries its own consent copy: consenting to the hosted (Stripe review)
// wording never authorizes an immediate charge.
export const MAX_UPGRADE_CHARGE_CONFIRM_BODY =
  "Max is $100 per month, charged to your saved card now. Your billing cycle restarts today.";
export const MAX_UPGRADE_CONFIRM_LABEL = "Upgrade now";
export const MAX_UPGRADE_BUSY_LABEL = "Upgrading...";
export const MAX_UPGRADE_BROWSER_STATUS = "Waiting for you to confirm in the browser";
export const MAX_UPGRADE_WAITING_STATUS = "Upgrade started. Waiting for payment confirmation.";
export const MAX_UPGRADE_READY_STATUS = "Max is active.";
export const MAX_UPGRADE_SLOW_STATUS =
  "Payment not confirmed yet. Check billing in your account portal.";
// A hosted round trip that outlasts its poll window usually means the user is
// still reviewing (or abandoned) the Stripe page, not that payment failed, so
// this copy stays non-terminal and points at the retry.
export const MAX_UPGRADE_HOSTED_SLOW_STATUS =
  "Still waiting for payment confirmation. If you closed the Stripe page, you can try again.";
export const MAX_UPGRADE_PORTAL_LABEL = "Open billing";
export const MAX_UPGRADE_STALE_ACTION_NOTICE = "Your plan changed - pick an option again";

export const MAX_GRANT_POLL_INTERVAL_MS = 2500;
// The PATCH transport only waits on the credit-grant webhook; the hosted
// transport also waits on the user reading and confirming the Stripe page,
// which routinely takes minutes.
export const MAX_GRANT_POLL_TIMEOUT_MS = 30_000;
export const MAX_GRANT_HOSTED_POLL_TIMEOUT_MS = 300_000;

type MutableMaxGrantWait = {
  readonly accountId: string | undefined;
  readonly baselineCredits: number;
  /** Whether the upgrade went through the hosted browser flow; drives the
   * slow-phase copy on every surface, including ones that inherit the wait. */
  readonly hosted: boolean;
  phase: "browser" | "waiting" | "slow";
};

export type MaxGrantWait = Readonly<MutableMaxGrantWait>;

// The account snapshot is shared across views, so the pending grant must be
// shared too. This session-only record keeps an optimistic plan mirror from
// being announced if the user moves between an upgrade surface and Billing.
let activeMaxGrantWait: MutableMaxGrantWait | undefined;

export function beginMaxGrantWait(
  baselineCredits: number,
  accountId: string | undefined,
  phase: "browser" | "waiting" = "waiting",
): MaxGrantWait {
  activeMaxGrantWait = { accountId, baselineCredits, hosted: phase === "browser", phase };
  return activeMaxGrantWait;
}

export function currentMaxGrantWait(): MaxGrantWait | undefined {
  return activeMaxGrantWait;
}

export function maxGrantWaitForAccount(accountId: string | undefined): MaxGrantWait | undefined {
  return activeMaxGrantWait?.accountId === accountId ? activeMaxGrantWait : undefined;
}

export function isMaxGrantWaitCurrent(wait: MaxGrantWait): boolean {
  return activeMaxGrantWait === wait;
}

export function markMaxGrantWaitSlow(wait: MaxGrantWait): void {
  if (activeMaxGrantWait === wait) activeMaxGrantWait.phase = "slow";
}

export function markMaxGrantWaitWaiting(wait: MaxGrantWait): void {
  if (activeMaxGrantWait === wait) activeMaxGrantWait.phase = "waiting";
}

/** Whether a hosted upgrade-session failure is a DEFINITIVE capability
 * signal: this OS Accounts deploy cannot provide the browser flow (the route
 * is missing - the 404/405 shape mapped in os_accounts.rs - or the plan is
 * not enabled there). Only these signals may offer the PATCH transport, and
 * only behind a fresh charge-now confirm; the hosted dialog's consent (review
 * on a Stripe page) never authorizes a saved-card charge. Transient failures
 * (network, empty response, auth refresh) are ordinary retryable errors. */
export function isHostedMaxUpgradeFallbackError(error: unknown): boolean {
  return new Set(["upgrade_session_unavailable", "plan_not_enabled"]).has(errorCode(error) ?? "");
}

/** Slow-phase status for a grant wait; the hosted flow keeps non-terminal
 * copy because the user may still be reviewing the Stripe page. */
export function maxUpgradeSlowStatus(wait: MaxGrantWait): string {
  return wait.hosted ? MAX_UPGRADE_HOSTED_SLOW_STATUS : MAX_UPGRADE_SLOW_STATUS;
}

/** The status line for a wait's current phase. */
export function maxUpgradeWaitStatus(wait: MaxGrantWait): string {
  if (wait.phase === "browser") return MAX_UPGRADE_BROWSER_STATUS;
  if (wait.phase === "slow") return maxUpgradeSlowStatus(wait);
  return MAX_UPGRADE_WAITING_STATUS;
}

const MAX_UPGRADE_WAIT_STATUSES = new Set<string>([
  MAX_UPGRADE_BROWSER_STATUS,
  MAX_UPGRADE_WAITING_STATUS,
  MAX_UPGRADE_SLOW_STATUS,
  MAX_UPGRADE_HOSTED_SLOW_STATUS,
]);

/** Whether a status/notice string is one of the wait-phase lines. The wait's
 * phase advances by in-place mutation, which identity-based reconciliation
 * cannot see; surfaces that snapshot phase copy into state use this to swap
 * a stale phase line for the live one without clobbering unrelated notices
 * (error messages, the ready announcement). */
export function isMaxUpgradeWaitStatus(status: string | null | undefined): boolean {
  return status != null && MAX_UPGRADE_WAIT_STATUSES.has(status);
}

export function clearMaxGrantWait(wait?: MaxGrantWait): void {
  if (wait === undefined || activeMaxGrantWait === wait) activeMaxGrantWait = undefined;
}

/** Whether a snapshot refreshed after an `already_on_plan` rejection still
 * looks like a grant is pending, so a grant poll is worth starting. The plan
 * not reading Max yet, or the credit balance sitting exactly where it stood
 * at confirm time, means the server-side change has not propagated. Any
 * credits movement (or a snapshot with no credits reading, which a poll could
 * never see rise) means the account is live or long settled - the surface
 * should re-derive from the refreshed snapshot instead of parking on a poll
 * that cannot succeed. A failed refresh (undefined) counts as pending: the
 * poll itself refreshes and can recover. Downward movement also reads as
 * settled on purpose: it usually means a stale baseline from a drained Max
 * account, where a poll could never succeed. The narrow miss (a metered
 * charge settling mid-upgrade) re-derives an honest top-up prompt the user
 * must still explicitly confirm. */
export function accountLooksPreGrant(
  account: AccountStatus | undefined,
  baselineCredits: number,
): boolean {
  if (account === undefined) return true;
  if (account.subscription?.plan !== "max") return true;
  const credits = account.balance?.credits;
  if (typeof credits !== "number") return false;
  return credits === baselineCredits;
}

/** Whether a refreshed snapshot shows the Max credit grant landed: the plan
 * flipped to Max AND the credit balance rose above where it stood before the
 * upgrade. The grant can land without making a deeply negative credit balance
 * positive, so the credits delta itself is the anchor. */
export function maxGrantLanded(
  account: AccountStatus | undefined,
  baselineCredits: number,
): boolean {
  if (account?.subscription?.plan !== "max") return false;
  const credits = account.balance?.credits;
  return typeof credits === "number" && credits > baselineCredits;
}

export type MaxGrantPollOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

/** Polls `refresh` until the Max grant lands or the timeout passes. The upgrade
 * transport resolves before the webhook grants the new credits, so surfaces
 * poll briefly instead of parking on a stale credit balance. Resolves true
 * once the grant is visible (the last `refresh` has already pushed the fresh
 * snapshot to the caller's state), false on timeout.
 *
 * The returned promise ALWAYS resolves, never rejects: callers chain their
 * cleanup (clearing waiting panels and statuses) on the resolution, so a
 * rejection would pin those surfaces forever. A refresh that throws on one
 * tick is a transient miss and the poll keeps going until the deadline. */
export async function pollForMaxGrant(
  refresh: () => Promise<AccountStatus | undefined>,
  baselineCredits: number,
  options: MaxGrantPollOptions = {},
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? MAX_GRANT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? MAX_GRANT_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastRefreshError: unknown;
  for (;;) {
    try {
      const next = await refresh();
      if (maxGrantLanded(next, baselineCredits)) return true;
    } catch (error) {
      lastRefreshError = error;
    }
    if (Date.now() + intervalMs > deadline) {
      if (lastRefreshError !== undefined) {
        console.debug("[max-upgrade] grant poll timed out with refresh failures", lastRefreshError);
      }
      return false;
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
