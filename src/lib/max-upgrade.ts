import type { AccountStatus } from "./tauri";

// Single source of truth for the Max upgrade confirm and status copy. The
// charge semantics live in the backend (today: full charge with the billing
// cycle restarting immediately); if they shift, this is the ONE place the
// wording changes.
export const MAX_UPGRADE_CONFIRM_TITLE = "Upgrade to Max?";
export const MAX_UPGRADE_CONFIRM_BODY =
  "Max is $100 per month, charged to your saved card now. Your billing cycle restarts today.";
export const MAX_UPGRADE_CONFIRM_LABEL = "Upgrade now";
export const MAX_UPGRADE_BUSY_LABEL = "Upgrading...";
// The PATCH returns before the credit grant lands (it arrives via webhook a
// moment later), so success feedback comes in two steps.
export const MAX_UPGRADE_WAITING_STATUS = "You are on Max now. Your new credits are on the way.";
export const MAX_UPGRADE_READY_STATUS = "You are on Max now. Your new credits are ready.";
export const MAX_UPGRADE_SLOW_STATUS =
  "You are on Max now. Credits are taking longer than usual; refresh in a moment.";

export const MAX_GRANT_POLL_INTERVAL_MS = 2500;
export const MAX_GRANT_POLL_TIMEOUT_MS = 30_000;

/** Whether a refreshed snapshot shows the Max credit grant landed: the plan
 * flipped to Max AND the balance rose above where it stood before the
 * upgrade (a depleted account crossing back over zero also qualifies). */
export function maxGrantLanded(
  account: AccountStatus | undefined,
  baselineCredits: number,
): boolean {
  if (account?.subscription?.plan !== "max") return false;
  const credits = account.balance?.credits;
  return typeof credits === "number" && credits > Math.max(baselineCredits, 0);
}

export type MaxGrantPollOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

/** Polls `refresh` until the Max grant lands or the timeout passes. The plan
 * change PATCH resolves before the webhook grants the new credits, so
 * surfaces poll briefly instead of parking on a stale balance. Resolves true
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
