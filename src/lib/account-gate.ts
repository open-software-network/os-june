import type { AccountStatus } from "./tauri";

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

export function depletedBalanceActionLabel(account: AccountStatus) {
  return shouldOpenPortalForDepletedBalance(account)
    ? "Top up credits"
    : "Upgrade";
}

export function shouldOpenPortalForDepletedBalance(account: AccountStatus) {
  return account.subscription?.subscribed === true;
}

function hasKnownNonLiveSubscription(account: AccountStatus): boolean {
  const subscription = account.subscription;
  if (!subscription) return false;
  if (hasLiveSubscription(account)) return false;
  if (subscription.subscribed === false) return true;

  const status = subscription.status;
  return typeof status === "string" && status.length > 0;
}

// New users start from their OS Accounts credits, not a card-gated
// subscription. Only block the shell when the backend positively reports a
// zero-or-negative balance and a non-live subscription state. Older account
// snapshots may omit `credits` or subscription status; treat those as usable
// and let the metered action return a precise out-of-credits error if needed.
export function shouldBlockOnFunding(account: AccountStatus): boolean {
  if (!account.signedIn) return false;
  if (hasLiveSubscription(account)) return false;
  if (!hasKnownNonLiveSubscription(account)) return false;

  const credits = account.balance?.credits;
  return typeof credits === "number" && credits <= 0;
}
