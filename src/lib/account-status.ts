import { useCallback, useEffect, useState } from "react";
import { osAccountsLogout, osAccountsStatus } from "./tauri";
import type { AccountStatus } from "./tauri";

const EMPTY_STATUS: AccountStatus = { signedIn: false, configured: false };

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
      if (forceLogoutOnMount) {
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

  // Refetch when the app regains attention so the user sees their post-top-up
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

function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
