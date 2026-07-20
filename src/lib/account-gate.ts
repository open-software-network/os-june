import { AUTO_MODEL_ID } from "./hermes-session-model-selection";
import { modelAvailableForMode } from "./model-privacy";
import type { AccountStatus, VeniceModelDto } from "./tauri";

// Single source of truth for whether an action that depends on OS Accounts
// should be blocked behind the sign-in prompt. Keep this pure — it's called
// from App.tsx and from tests, and it's the file to edit when the policy
// needs to tighten (e.g. require a non-zero balance, require an
// upstream provider model to be configured, etc.).
export function shouldBlockOnSignIn(account: AccountStatus): boolean {
  return !account.signedIn;
}

export function hasLiveSubscription(account: AccountStatus): boolean {
  const status = account.subscription?.status;
  return status === "trialing" || status === "active";
}

/** Whether the account is on the Max plan. Legacy subscription rows predate
 * plan tiers and carry no slug; they are all Pro, so only an explicit "max"
 * slug counts as Max. */
export function isOnMaxPlan(account: AccountStatus): boolean {
  return account.subscription?.subscribed === true && account.subscription?.plan === "max";
}

/** The single action a signed-in user with a depleted balance can take to keep
 * going, decided by their tier:
 * - `top_up`: Max subscribers buy more credits (only Max may buy credits).
 * - `upgrade_to_max`: Pro subscribers upgrade in place to Max. This is a Pro
 *   user's ONLY path once their monthly credits run out; no top-up is offered.
 * - `subscribe`: everyone else (Free / signed-out-of-plan) starts a checkout. */
export type DepletedBalanceAction = "top_up" | "upgrade_to_max" | "subscribe";

export function depletedBalanceAction(account: AccountStatus): DepletedBalanceAction {
  if (account.subscription?.subscribed !== true) return "subscribe";
  return isOnMaxPlan(account) ? "top_up" : "upgrade_to_max";
}

export function depletedBalanceActionLabel(account: AccountStatus) {
  switch (depletedBalanceAction(account)) {
    case "top_up":
      return "Top up credits";
    case "upgrade_to_max":
      return "Upgrade to Max";
    default:
      return "Upgrade";
  }
}

/** True only when the depleted-balance action opens the account portal (the Max
 * top-up path). Pro subscribers upgrade in place instead, and Free users go to
 * checkout, so neither opens the portal. */
export function shouldOpenPortalForDepletedBalance(account: AccountStatus) {
  return depletedBalanceAction(account) === "top_up";
}

function hasKnownNonLiveSubscription(account: AccountStatus): boolean {
  const subscription = account.subscription;
  if (!subscription) return false;
  if (hasLiveSubscription(account)) return false;
  if (subscription.subscribed === false) return true;

  const status = subscription.status;
  return typeof status === "string" && status.length > 0;
}

function hasNegativeBalance(account: AccountStatus): boolean {
  const credits = account.balance?.credits;
  return typeof credits === "number" && credits < 0;
}

// New users start from their OS Accounts credits, not a card-gated
// subscription. A known negative balance is never usable, even for live
// subscribers, because it means spending has already crossed the credit floor.
// Zero-credit live subscribers keep the current credit-line behavior. Older
// account snapshots may omit `credits` or subscription status; treat those as
// usable and let the metered action return a precise out-of-credits error if
// needed.
export function shouldBlockOnFunding(account: AccountStatus): boolean {
  if (!account.signedIn) return false;
  if (hasNegativeBalance(account)) return true;
  if (hasLiveSubscription(account)) return false;
  if (!hasKnownNonLiveSubscription(account)) return false;

  const credits = account.balance?.credits;
  return typeof credits === "number" && credits <= 0;
}

/** The active text route as known by a composer. `activeModel` must be the
 * exact live-catalog entry for `activeModelId`; callers leave it undefined
 * when the selection is unknown so the funding decision fails closed instead
 * of trusting a synthetic picker stub or an id convention. */
export type TextFundingModelContext = {
  activeModelId?: string;
  activeModel?: Pick<VeniceModelDto, "id" | "provider" | "capabilities">;
  veniceApiKeyConfigured: boolean;
};

/** Split text generation from the general June-credit gate. Explicit Venice
 * BYOK text can continue while June funding is unavailable, but only when the
 * configured key and the active concrete catalog entry prove that route. */
export function shouldBlockTextOnFunding(
  fundingRequired: boolean,
  context: TextFundingModelContext,
): boolean {
  if (!fundingRequired) return false;
  const model = context.activeModel;
  return !(
    context.veniceApiKeyConfigured &&
    context.activeModelId &&
    context.activeModelId !== AUTO_MODEL_ID &&
    model?.id === context.activeModelId &&
    model.provider === "venice" &&
    modelAvailableForMode("generation", model)
  );
}
