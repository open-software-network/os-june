import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  focusMainWindow,
  osAccountsLogin,
  osAccountsOpenPortal,
  osAccountsStartTrialCheckout,
} from "./tauri";
import type { AccountStatus } from "./tauri";

// Mirrored from src-tauri/src/os_accounts.rs: the stored grant lacks a scope
// the direct checkout needs (it predates billing:write). A token refresh can
// never broaden a grant, so the recovery is an interactive re-auth.
const NEEDS_REAUTH_CODE = "trial_checkout_needs_reauth";
// Raised by os_accounts_login when the user cancels the browser sign-in.
const LOGIN_CANCELED_CODE = "login_canceled";

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

/** Fired by the Rust core when the `osscribe://billing/callback` deep link
 * lands — the user finished (or canceled) checkout in the browser. Payload is
 * "success" or "cancel". */
const BILLING_CALLBACK_EVENT = "os-accounts-billing-callback";

/** Phases of the one-click trial flow. `reauth` = the stored grant lacked a
 * scope and a browser sign-in bounce is in flight to pick up the current
 * ones. `waiting` = Stripe Checkout is open in the browser and we're polling
 * for the subscription to appear. */
export type TrialCheckoutPhase = "idle" | "opening" | "reauth" | "waiting";

// Stripe's webhook usually settles within a couple of seconds of payment;
// poll fast enough that the app reacts while the user is still looking at
// the browser's success page.
const WAITING_POLL_INTERVAL_MS = 2_500;

export type UseTrialCheckout = {
  phase: TrialCheckoutPhase;
  /** Set when the direct checkout path failed and we fell back to opening
   * the portal — the user finishes the trial there instead. */
  usedPortalFallback: boolean;
  error?: string;
  /** Friendly non-error status, e.g. after the user cancels checkout. */
  notice?: string;
  /** Open Stripe Checkout (or the portal as fallback) in the browser. */
  start: () => Promise<void>;
  /** Manual "check again" affordance while waiting. */
  checkNow: () => Promise<void>;
};

export function isSubscriptionActive(account: AccountStatus): boolean {
  const status = account.subscription?.status;
  return status === "trialing" || status === "active";
}

/**
 * One-click free trial shared by the onboarding wizard and the trial gate.
 *
 * `start()` asks the Rust core to mint the subscription Stripe Checkout
 * session and open it in the system browser, then polls the account status
 * until the subscription flips to trialing/active. When that happens the hook
 * pulls the app back to the foreground and fires `onActivated` exactly once.
 * A grant minted before this build's scopes (no billing:write) triggers a
 * re-auth and one retry, so those users still land directly on Stripe. Only
 * when the direct path stays unavailable (subscriptions disabled, network)
 * does it open the accounts portal instead, keeping the same polling, so no
 * user is ever stranded without a way forward.
 */
export function useTrialCheckout({
  account,
  onRefresh,
  onActivated,
}: {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onActivated: () => void;
}): UseTrialCheckout {
  const [phase, setPhase] = useState<TrialCheckoutPhase>("idle");
  const [usedPortalFallback, setUsedPortalFallback] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const activatedRef = useRef(false);

  // Callers pass inline closures for these, so depending on them directly
  // would tear down and re-arm the listener/poll effects on every parent
  // render (resetting the poll countdown each time). Forward them through
  // refs instead and keep the effects keyed on real state.
  const onRefreshRef = useRef(onRefresh);
  const onActivatedRef = useRef(onActivated);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
    onActivatedRef.current = onActivated;
  });

  const subscribed = isSubscriptionActive(account);

  // The post-checkout deep link (Stripe → portal /return → osscribe://)
  // already foregrounded the app; react immediately instead of waiting out
  // the poll interval. A cancel returns the UI to the pitch, not an error.
  useEffect(() => {
    const unlisten = listen<string>(BILLING_CALLBACK_EVENT, (event) => {
      if (event.payload === "cancel") {
        setPhase("idle");
        setNotice("Checkout canceled. Ready when you are.");
        return;
      }
      void onRefreshRef.current();
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  // Activation watcher. Covers every path to a live subscription — direct
  // checkout, portal fallback, even a second device — because it keys off
  // the account snapshot, not off how checkout was opened.
  useEffect(() => {
    if (!subscribed || activatedRef.current) return;
    activatedRef.current = true;
    if (phase === "waiting") {
      // The user is in the browser; bring June back to the front so the
      // "you're in" moment happens in the app, not on a Stripe success page.
      void focusMainWindow().catch(() => undefined);
    }
    setPhase("idle");
    onActivatedRef.current();
  }, [subscribed, phase]);

  useEffect(() => {
    if (phase !== "waiting") return;
    const interval = window.setInterval(() => {
      void onRefreshRef.current();
    }, WAITING_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [phase]);

  const start = useCallback(async () => {
    setError(undefined);
    setNotice(undefined);
    setPhase("opening");

    const openDirectCheckout = async () => {
      const result = await osAccountsStartTrialCheckout();
      if (result.outcome === "alreadySubscribed") {
        // Stale snapshot (e.g. subscribed on another machine); the refreshed
        // status trips the activation watcher above.
        await onRefreshRef.current();
        setPhase("idle");
        return;
      }
      setPhase("waiting");
    };

    const openPortalFallback = async () => {
      try {
        await osAccountsOpenPortal();
        setUsedPortalFallback(true);
        setPhase("waiting");
      } catch (portalError) {
        setError(messageFromError(portalError));
        setPhase("idle");
      }
    };

    try {
      await openDirectCheckout();
    } catch (checkoutError) {
      // A grant from before this build's scopes can't mint the checkout
      // session, and refreshing can't fix that. Re-run sign-in (for an
      // already-authenticated user it's a quick browser bounce) to pick up
      // the current scopes, then retry the direct path — the user still
      // lands on Stripe, not the portal.
      if (errorCode(checkoutError) === NEEDS_REAUTH_CODE) {
        setPhase("reauth");
        try {
          await osAccountsLogin();
        } catch (loginError) {
          if (errorCode(loginError) === LOGIN_CANCELED_CODE) {
            setPhase("idle");
            setNotice("Sign-in canceled. Ready when you are.");
            return;
          }
          await openPortalFallback();
          return;
        }
        setPhase("opening");
        try {
          await openDirectCheckout();
          return;
        } catch {
          // Re-auth didn't unblock the direct path; the portal always can.
        }
      }
      // Direct checkout unavailable — subscriptions disabled server-side,
      // network trouble, or a re-auth that still lacks the scope. The portal
      // can always do it.
      await openPortalFallback();
    }
  }, []);

  const checkNow = useCallback(async () => {
    await onRefreshRef.current();
  }, []);

  return { phase, usedPortalFallback, error, notice, start, checkNow };
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
