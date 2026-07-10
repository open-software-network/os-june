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
 * - `changed_plan`: the existing subscription was changed in place over the
 *   PATCH transport; refresh until the associated credit grant lands.
 * - `opened_upgrade_session`: the browser opened for a hosted existing-plan
 *   upgrade; poll through confirmation until the associated grant lands.
 * - `opened_browser`: checkout or the portal opened; the window focus-refresh
 *   reconciles the balance later.
 * - `charge_confirmation_required`: this OS Accounts deploy cannot host the
 *   browser flow (a definitive capability signal). Nothing was charged; the
 *   caller must gather a fresh confirm under the charge-now copy and dispatch
 *   again with the `charge_now` transport before any PATCH happens.
 * - `already_on_plan`: the server says the subscription already matches the
 *   requested plan. The caller should refresh once and either poll for a
 *   still-pending grant or re-derive its surface from the fresh snapshot.
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
  | "charge_confirmation_required"
  | "already_on_plan"
  | "upgrade_required"
  | "subscribe_required";

/** Which billed transport the user consented to: `hosted` opens the browser
 * review (charges nothing directly), `charge_now` PATCHes the subscription
 * and charges the saved card immediately. */
export type MaxUpgradeTransport = "hosted" | "charge_now";

/** Runs the one correct depleted-balance action for the account's tier:
 * - Max tops up (opens the account portal),
 * - Pro upgrades its existing subscription in place to Max,
 * - everyone else starts a checkout.
 *
 * Stale-snapshot rejections resolve as outcomes rather than throwing, and
 * never trigger a different billed action. A caller dispatching a confirmed
 * intent passes its captured action and plan so this helper does not
 * reclassify it after an account refresh. A charge may only happen under
 * copy the user actually consented to: the default hosted transport never
 * PATCHes; when the deploy cannot host the flow it resolves
 * `charge_confirmation_required` so the caller can collect an explicit
 * charge-now confirm and dispatch again with `transport: "charge_now"`. */
export async function runDepletedBalanceAction(
  account: AccountStatus,
  action: DepletedBalanceAction = depletedBalanceAction(account),
  upgradePlan: "max" = "max",
  transport: MaxUpgradeTransport = "hosted",
): Promise<DepletedBalanceOutcome> {
  if (action === "upgrade_to_max") {
    try {
      if (transport === "charge_now") {
        await osAccountsChangePlan(upgradePlan);
        return "changed_plan";
      }
      try {
        await osAccountsUpgradeSession(upgradePlan);
        return "opened_upgrade_session";
      } catch (err) {
        if (!isHostedMaxUpgradeFallbackError(err)) throw err;
        return "charge_confirmation_required";
      }
    } catch (err) {
      const code = errorCode(err);
      if (code === "already_on_plan") return "already_on_plan";
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
