import { useCallback, useEffect, useState } from "react";
import { osAccountsLogout, osAccountsStatus } from "./tauri";
import type { AccountStatus } from "./tauri";

const EMPTY_STATUS: AccountStatus = { signedIn: false, configured: false };
const DEMO_ACCOUNT: AccountStatus = {
  signedIn: true,
  configured: true,
  user: {
    id: "usr_browser_demo",
    handle: "browser-demo",
    displayName: "Browser demo",
  },
  balance: { credits: 1200, usdMillis: 1200, usageRemainingPercent: 100 },
  subscription: { subscribed: false },
};

export type UseAccountStatusOptions = {
  forceLogoutOnMount?: boolean;
};

export type UseAccountStatus = {
  account: AccountStatus;
  loading: boolean;
  error?: string;
  refresh: () => Promise<AccountStatus | undefined>;
  setAccount: (next: AccountStatus) => void;
};

export function useAccountStatus(
  options: UseAccountStatusOptions = {},
): UseAccountStatus {
  const { forceLogoutOnMount = false } = options;
  const [account, setAccount] = useState<AccountStatus>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (browserOnboardingDemoEnabled()) {
      setAccount(DEMO_ACCOUNT);
      setError(undefined);
      return DEMO_ACCOUNT;
    }
    try {
      const next = await osAccountsStatus();
      setAccount(next);
      setError(undefined);
      return next;
    } catch (err) {
      setError(messageFromError(err));
      return undefined;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    async function loadInitialStatus() {
      if (forceLogoutOnMount && !browserOnboardingDemoEnabled()) {
        await osAccountsLogout();
      }
      await refresh();
    }
    loadInitialStatus().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [forceLogoutOnMount, refresh]);

  // Refetch when the app regains attention so the user sees their post-upgrade
  // balance without hunting for a refresh button. `focus` and `visibilitychange`
  // both fire in Tauri webviews; the inFlight flag de-dupes a focus event that
  // arrives while the on-mount fetch is still pending.
  useEffect(() => {
    let inFlight = false;
    function maybeRefresh() {
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      refresh().finally(() => {
        inFlight = false;
      });
    }
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
    };
  }, [refresh]);

  return { account, loading, error, refresh, setAccount };
}

function browserOnboardingDemoEnabled() {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return (
    new URLSearchParams(window.location.search).get("juneDemoAccount") === "1"
  );
}

function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
