import type { Dispatch, ReactNode, SetStateAction } from "react";
import { AccountGate, AccountStatusFailure } from "../components/account/AccountGate";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import { Spinner } from "../components/ui/Spinner";
import { applyAutostartDefaultOnce } from "../lib/autostart";
import { hasCompletedAnyOnboardingVersion, markOnboardingComplete } from "../lib/onboarding";
import type { AccountStatus } from "../lib/tauri";
import { handleTitlebarPointerDown } from "./app-helpers";

type AppAccountGateOptions = {
  account: AccountStatus;
  accountError: string | undefined;
  accountLoading: boolean;
  devAccountsUnconfigured: boolean;
  handleAccountChanged: (nextAccount: AccountStatus) => void;
  onboardingRequired: boolean;
  refreshAccount: () => Promise<unknown>;
  setOnboardingDone: Dispatch<SetStateAction<boolean>>;
  signInRequired: boolean;
};

export function renderAppAccountGate({
  account,
  accountError,
  accountLoading,
  devAccountsUnconfigured,
  handleAccountChanged,
  onboardingRequired,
  refreshAccount,
  setOnboardingDone,
  signInRequired,
}: AppAccountGateOptions): ReactNode | null {
  if (accountLoading) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <div className="welcome-screen welcome-screen-loading">
          <Spinner size="lg" aria-label="Starting June" />
          <p>Starting June...</p>
        </div>
      </main>
    );
  }

  if (accountError && !account.signedIn && !devAccountsUnconfigured) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <AccountStatusFailure message={accountError} onRetry={refreshAccount} />
      </main>
    );
  }

  if (onboardingRequired) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <OnboardingFlow
          account={account}
          onAccountChanged={handleAccountChanged}
          onComplete={() => {
            // Read before marking complete: marking writes the completion
            // key that distinguishes a fresh install from a wizard replay.
            const firstOnboardingCompletion = !hasCompletedAnyOnboardingVersion();
            markOnboardingComplete();
            // A background assistant only works while it runs; make sure a
            // fresh install starts at login. One-shot and first-run only: a
            // user who later turns the login item off stays off, and wizard
            // replays never re-enroll existing users.
            void applyAutostartDefaultOnce({ firstOnboardingCompletion });
            setOnboardingDone(true);
          }}
        />
      </main>
    );
  }

  if (signInRequired) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <AccountGate
          account={account}
          loading={accountLoading}
          onAccountChanged={handleAccountChanged}
        />
      </main>
    );
  }

  return null;
}
