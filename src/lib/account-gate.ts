import type { AccountStatus } from "./tauri";

// Single source of truth for whether an action that depends on OS Accounts
// should be blocked behind the sign-in prompt. Keep this pure — it's called
// from App.tsx and from tests, and it's the file to edit when the policy
// needs to tighten (e.g. require a non-zero balance, require an
// upstream provider model to be configured, etc.).
export function shouldBlockOnSignIn(account: AccountStatus): boolean {
  return !account.signedIn;
}

// Membership is mandatory: every user must be on a subscription (trialing or
// active) to use the app at all — credits alone do NOT grant access, so a
// leftover promo balance or a cancelled subscriber with unspent top-ups still
// lands on the trial gate. An unknown subscription state (transient fetch
// failure) also blocks; the gate's poll and the account hook's focus refresh
// recover it within seconds, which beats silently admitting non-members.
export function shouldBlockOnTrial(account: AccountStatus): boolean {
  if (!account.signedIn) return false;
  const status = account.subscription?.status;
  return status !== "trialing" && status !== "active";
}
