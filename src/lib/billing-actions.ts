import { depletedBalanceAction } from "./account-gate";
import { isTopUpRequiresMaxError } from "./errors";
import { osAccountsChangePlan, osAccountsOpenPortal, osAccountsUpgrade } from "./tauri";
import type { AccountStatus } from "./tauri";

/** How the resolved action ended:
 * - `changed_plan`: the plan was changed in place; refresh account status to
 *   pick up the freshly granted credits.
 * - `opened_browser`: checkout or the portal opened; the window focus-refresh
 *   reconciles the balance later.
 * - `upgrade_required`: the backend gated a top-up behind Max, meaning the
 *   local snapshot was stale (it said Max; the server disagrees). The caller
 *   should refresh the account snapshot so the depleted-balance surfaces
 *   re-render as the explicit upgrade-to-Max prompt; the raw gate error is
 *   never surfaced. */
export type DepletedBalanceOutcome = "changed_plan" | "opened_browser" | "upgrade_required";

/** Runs the one correct depleted-balance action for the account's tier:
 * - Max tops up (opens the account portal),
 * - Pro upgrades in place to Max (credits granted immediately),
 * - everyone else starts a checkout.
 *
 * A top-up rejected with the Max gate resolves as `upgrade_required` rather
 * than throwing. Deliberately, it does NOT auto-invoke the plan change: a
 * plan change is a billed action and must only ever run from an explicit user
 * click, never from an error handler acting on state the server just proved
 * stale. */
export async function runDepletedBalanceAction(
  account: AccountStatus,
): Promise<DepletedBalanceOutcome> {
  const action = depletedBalanceAction(account);
  if (action === "upgrade_to_max") {
    await osAccountsChangePlan("max");
    return "changed_plan";
  }
  try {
    await (action === "top_up" ? osAccountsOpenPortal() : osAccountsUpgrade());
    return "opened_browser";
  } catch (err) {
    if (isTopUpRequiresMaxError(err)) return "upgrade_required";
    throw err;
  }
}
