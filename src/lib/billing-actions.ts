import { depletedBalanceAction } from "./account-gate";
import { errorCode, isTopUpRequiresMaxError } from "./errors";
import { osAccountsChangePlan, osAccountsOpenPortal, osAccountsUpgrade } from "./tauri";
import type { AccountStatus } from "./tauri";

/** How the resolved action ended:
 * - `changed_plan`: the subscription now matches the requested plan (changed
 *   in place, or the server reported `already_on_plan` for a stale snapshot);
 *   refresh account status to show the current plan and credits.
 * - `opened_browser`: checkout or the portal opened; the window focus-refresh
 *   reconciles the balance later.
 * - `upgrade_required`: the backend gated a top-up behind Max, meaning the
 *   local snapshot was stale (it said Max; the server disagrees). The caller
 *   should refresh the account snapshot so the depleted-balance surfaces
 *   re-render as the explicit upgrade-to-Max prompt; the raw gate error is
 *   never surfaced.
 * - `subscribe_required`: the plan change was rejected with
 *   `subscription_required` (no active subscription server-side). Refresh so
 *   the surfaces fall back to the subscribe prompt. */
export type DepletedBalanceOutcome =
  | "changed_plan"
  | "opened_browser"
  | "upgrade_required"
  | "subscribe_required";

/** Runs the one correct depleted-balance action for the account's tier:
 * - Max tops up (opens the account portal),
 * - Pro upgrades in place to Max (credits granted immediately),
 * - everyone else starts a checkout.
 *
 * Stale-snapshot rejections resolve as outcomes rather than throwing, and
 * deliberately never auto-invoke another billed action from the error
 * handler: a plan change or checkout must only ever run from an explicit
 * user click, so the caller refreshes and re-renders the right prompt. */
export async function runDepletedBalanceAction(
  account: AccountStatus,
): Promise<DepletedBalanceOutcome> {
  const action = depletedBalanceAction(account);
  if (action === "upgrade_to_max") {
    try {
      await osAccountsChangePlan("max");
      return "changed_plan";
    } catch (err) {
      const code = errorCode(err);
      // The server says the subscription is already Max: the snapshot was
      // stale and there is nothing to buy. Treat like a completed change so
      // the caller refreshes and shows the current plan.
      if (code === "already_on_plan") return "changed_plan";
      if (code === "subscription_required") return "subscribe_required";
      throw err;
    }
  }
  try {
    await (action === "top_up" ? osAccountsOpenPortal() : osAccountsUpgrade());
    return "opened_browser";
  } catch (err) {
    if (isTopUpRequiresMaxError(err)) return "upgrade_required";
    throw err;
  }
}
