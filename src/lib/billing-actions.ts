import { depletedBalanceAction, type DepletedBalanceAction } from "./account-gate";
import { isTopUpRequiresMaxError } from "./errors";
import { osAccountsOpenPortal, osAccountsUpgrade } from "./tauri";
import type { AccountStatus } from "./tauri";

/** How the resolved action ended:
 * - `opened_browser`: checkout or the portal opened; the window focus-refresh
 *   reconciles the balance later.
 * - `upgrade_required`: the backend gated a top-up behind Max, meaning the
 *   local snapshot was stale (it said Max; the server disagrees). The caller
 *   should refresh the account snapshot so the depleted-balance surfaces
 *   re-render as the explicit upgrade-to-Max prompt; the raw gate error is
 *   never surfaced. */
export type DepletedBalanceOutcome = "opened_browser" | "upgrade_required";

/** Runs the one correct depleted-balance action for the account's tier:
 * - Max tops up (opens the account portal),
 * - Pro starts hosted Max checkout in the external browser,
 * - everyone else starts a checkout.
 *
 * June never grants or assumes Max here. Only a refreshed OS Accounts account
 * snapshot may establish that the plan changed after checkout. June also
 * never builds checkout UI: `osAccountsUpgrade` opens OS Accounts' hosted URL.
 * The existing subscribe and top-up branches remain checkout and portal
 * handoffs respectively. A caller dispatching a confirmed intent passes its
 * captured action and plan so this helper does not reclassify it. */
export async function runDepletedBalanceAction(
  account: AccountStatus,
  action: DepletedBalanceAction = depletedBalanceAction(account),
  upgradePlan: "max" = "max",
): Promise<DepletedBalanceOutcome> {
  try {
    if (action === "top_up") {
      await osAccountsOpenPortal();
    } else if (action === "upgrade_to_max") {
      await osAccountsUpgrade(upgradePlan);
    } else {
      await osAccountsUpgrade();
    }
    return "opened_browser";
  } catch (err) {
    if (isTopUpRequiresMaxError(err)) return "upgrade_required";
    throw err;
  }
}
