import type { AccountStatus } from "./tauri";

// Single source of truth for whether an action that depends on OS Accounts
// should be blocked behind the sign-in prompt. Keep this pure — it's called
// from App.tsx and from tests, and it's the file to edit when the policy
// needs to tighten (e.g. require a non-zero balance, require an
// upstream provider model to be configured, etc.).
export function shouldBlockOnSignIn(account: AccountStatus): boolean {
  return !account.signedIn;
}
