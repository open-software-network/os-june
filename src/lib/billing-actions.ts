import { depletedBalanceAction, type DepletedBalanceAction } from "./account-gate";
import { errorCode, isTopUpRequiresMaxError } from "./errors";
import { isHostedMaxUpgradeFallbackError } from "./max-upgrade";
import {
  osAccountsChangePlan,
  osAccountsOpenPortal,
  osAccountsUpgrade,
  osAccountsUpgradeSession,
} from "./tauri";
import type { AccountStatus } from "./tauri";

/** How the resolved action ended:
 * - `changed_plan`: the existing subscription now matches the requested plan
 *   (changed in place, or the server reported `already_on_plan` for a stale
 *   snapshot); refresh until the associated credit grant lands.
 * - `opened_upgrade_session`: the browser opened for a hosted existing-plan
 *   upgrade; poll through confirmation until the associated grant lands.
 * - `opened_browser`: checkout or the portal opened; the window focus-refresh
 *   reconciles the balance later.
 * - `upgrade_required`: the backend gated a top-up behind Max, meaning the
 *   local snapshot was stale (it said Max; the server disagrees). The caller
 *   should refresh the account snapshot so the depleted-balance surfaces
 *   re-render as the explicit upgrade-to-Max prompt; the raw gate error is
 *   never surfaced.
 * - `subscribe_required`: the plan change was rejected because there is no
 *   active subscription server-side; refresh to show the subscribe path. */
export type DepletedBalanceOutcome =
  | "changed_plan"
  | "opened_upgrade_session"
  | "opened_browser"
  | "upgrade_required"
  | "subscribe_required";

/** Runs the one correct depleted-balance action for the account's tier:
 * - Max tops up (opens the account portal),
 * - Pro upgrades its existing subscription in place to Max,
 * - everyone else starts a checkout.
 *
 * Stale-snapshot rejections resolve as outcomes rather than throwing, and
 * never trigger a different billed action. A caller dispatching a confirmed
 * intent passes its captured action and plan so this helper does not
 * reclassify it after an account refresh. */
export async function runDepletedBalanceAction(
  account: AccountStatus,
  action: DepletedBalanceAction = depletedBalanceAction(account),
  upgradePlan: "max" = "max",
): Promise<DepletedBalanceOutcome> {
  if (action === "upgrade_to_max") {
    let hosted = false;
    try {
      try {
        await osAccountsUpgradeSession(upgradePlan);
        hosted = true;
      } catch (err) {
        if (!isHostedMaxUpgradeFallbackError(err)) throw err;
        await osAccountsChangePlan(upgradePlan);
      }
      return hosted ? "opened_upgrade_session" : "changed_plan";
    } catch (err) {
      const code = errorCode(err);
      if (code === "already_on_plan") return "changed_plan";
      if (code === "subscription_required") return "subscribe_required";
      throw err;
    }
  }

  try {
    if (action === "top_up") {
      await osAccountsOpenPortal();
    } else {
      await osAccountsUpgrade();
    }
    return "opened_browser";
  } catch (err) {
    if (isTopUpRequiresMaxError(err)) return "upgrade_required";
    throw err;
  }
}
