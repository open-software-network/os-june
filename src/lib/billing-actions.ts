import { depletedBalanceAction } from "./account-gate";
import { errorCode } from "./errors";
import { osAccountsChangePlan, osAccountsOpenPortal, osAccountsUpgrade } from "./tauri";
import type { AccountStatus } from "./tauri";

/** Whether the resolved action changed the plan in place (so the caller should
 * refresh account status to pick up the freshly granted credits) or opened the
 * browser (where the window focus-refresh reconciles the balance later). */
export type DepletedBalanceOutcome = "changed_plan" | "opened_browser";

/** Runs the one correct depleted-balance action for the account's tier:
 * - Max tops up (opens the account portal),
 * - Pro upgrades in place to Max (credits granted immediately),
 * - everyone else starts a checkout.
 *
 * A top-up that the backend rejects because it now requires Max
 * (`top_up_requires_max`) falls through to the in-place upgrade, so the user is
 * routed to the upgrade prompt instead of seeing a raw gating error. */
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
    if (errorCode(err) === "top_up_requires_max") {
      await osAccountsChangePlan("max");
      return "changed_plan";
    }
    throw err;
  }
}
