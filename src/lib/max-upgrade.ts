import type { AccountStatus } from "./tauri";
import { errorCode } from "./errors";

// Single source of truth for Max upgrade confirm and status copy. The plan
// change returns before payment is confirmed and the credit grant lands, so
// only the grant poll may advance the copy from waiting to active.
export const MAX_UPGRADE_CONFIRM_TITLE = "Upgrade to Max?";
export const MAX_UPGRADE_CONFIRM_BODY =
  "Max is $100 per month. A secure Stripe page will open in your browser so you can review and confirm the prorated charge.";
export const MAX_UPGRADE_CONFIRM_LABEL = "Upgrade now";
export const MAX_UPGRADE_BUSY_LABEL = "Upgrading...";
export const MAX_UPGRADE_BROWSER_STATUS = "Waiting for you to confirm in the browser";
export const MAX_UPGRADE_WAITING_STATUS = "Upgrade started. Waiting for payment confirmation.";
export const MAX_UPGRADE_READY_STATUS = "Max is active.";
export const MAX_UPGRADE_SLOW_STATUS =
  "Payment not confirmed yet. Check billing in your account portal.";
export const MAX_UPGRADE_PORTAL_LABEL = "Open billing";

export const MAX_GRANT_POLL_INTERVAL_MS = 2500;
export const MAX_GRANT_POLL_TIMEOUT_MS = 30_000;

type MutableMaxGrantWait = {
  readonly accountId: string | undefined;
  readonly baselineCredits: number;
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
  activeMaxGrantWait = { accountId, baselineCredits, phase };
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

/** Whether a hosted upgrade-session failure means this OS Accounts deploy
 * cannot provide the browser flow, so June should use the compatible PATCH
 * transport in the same confirmed user action. */
export function isHostedMaxUpgradeFallbackError(error: unknown): boolean {
  return new Set([
    "upgrade_session_unavailable",
    "plan_not_enabled",
    "network_error",
    "auth_refresh_unavailable",
    "empty_response",
  ]).has(errorCode(error) ?? "");
}

export function clearMaxGrantWait(wait?: MaxGrantWait): void {
  if (wait === undefined || activeMaxGrantWait === wait) activeMaxGrantWait = undefined;
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
