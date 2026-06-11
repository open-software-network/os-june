import type { AccountStatus } from "./tauri";

// Single source of truth for whether an action that depends on OS Accounts
// should be blocked behind the sign-in prompt. Keep this pure — it's called
// from App.tsx and from tests, and it's the file to edit when the policy
// needs to tighten (e.g. require a non-zero balance, require an
// upstream provider model to be configured, etc.).
export function shouldBlockOnSignIn(account: AccountStatus): boolean {
  return !account.signedIn;
}

// A positive balance means the account can already pay for metered AI calls,
// whether the credits came from a prepaid plan, a top-up, or a promo. Those
// users are members in every way that matters to the backend (authorize →
// charge succeeds), so pitching them a trial would be asking them to pay
// twice.
export function hasPlanCredits(account: AccountStatus): boolean {
  const balance = account.balance;
  if (!balance) return false;
  return (balance.credits ?? 0) > 0 || balance.usdMillis > 0;
}

// Membership requires a subscription (trialing or active) OR a positive
// credit balance. Credits-based plans predate subscriptions; their users can
// already pay for usage, so the trial gate stays out of their way until the
// balance runs dry. An unknown subscription state (transient fetch failure)
// with no credits still blocks; the gate's poll and the account hook's focus
// refresh recover it within seconds, which beats silently admitting
// non-members.
export function shouldBlockOnTrial(account: AccountStatus): boolean {
  if (!account.signedIn) return false;
  if (hasPlanCredits(account)) return false;
  const status = account.subscription?.status;
  return status !== "trialing" && status !== "active";
}
