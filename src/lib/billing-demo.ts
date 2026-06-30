// Dev-only console driver for the billing section: window.__billingDemo("pro")
// forces the Account → Billing card into a given plan state regardless of the
// real account, so every variant (Free, Pro, trialing, past due, running low,
// signed out) can be designed without a matching backend account.
// __billingDemo("all") stacks every variant on the page; __billingDemo("off")
// — or __billingDemo(false) — goes back to real data. __billingDemo() prints
// the list.
//
// The hook is imported unconditionally by the billing section (the override
// simply stays null in production); only the console command registration is
// gated on import.meta.env.DEV, in main.tsx.

import { useSyncExternalStore } from "react";
import type { AccountStatus } from "./tauri";

const BILLING_DEMO_EVENT = "june:billing-demo-changed";

/** A single forced variant, or "all" for the stacked gallery. */
export type BillingDemoPlan = BillingDemoKey | "all";

export type BillingDemoKey =
  | "free"
  | "freeLow"
  | "pro"
  | "trial"
  | "pastDue"
  | "signedOut";

type BillingDemoFixture = {
  label: string;
  account: AccountStatus;
};

const DEMO_USER = {
  id: "usr_billing_demo",
  handle: "billing-demo",
  displayName: "Billing demo",
};

// Future-dated relative to load (not absolute) so describeEnd() always renders
// an upcoming "Renews ..." / "Billing starts ..." date, no matter when this
// file was last touched.
const DAY_MS = 24 * 60 * 60 * 1000;
const RENEWS_AT = new Date(Date.now() + 24 * DAY_MS).toISOString();
const TRIAL_ENDS_AT = new Date(Date.now() + 7 * DAY_MS).toISOString();

// Ordered so the gallery reads from the default state outward to the edges.
export const BILLING_DEMO_FIXTURES: Record<BillingDemoKey, BillingDemoFixture> =
  {
    free: {
      label: "Free plan",
      account: {
        signedIn: true,
        configured: true,
        user: DEMO_USER,
        balance: { credits: 3900, usdMillis: 3900, usageRemainingPercent: 78 },
        subscription: { subscribed: false },
      },
    },
    freeLow: {
      label: "Free plan, running low",
      account: {
        signedIn: true,
        configured: true,
        user: DEMO_USER,
        balance: { credits: 300, usdMillis: 300, usageRemainingPercent: 6 },
        subscription: { subscribed: false },
      },
    },
    pro: {
      label: "Pro, active",
      account: {
        signedIn: true,
        configured: true,
        user: DEMO_USER,
        balance: {
          credits: 12800,
          usdMillis: 12800,
          usageRemainingPercent: 64,
        },
        subscription: {
          subscribed: true,
          status: "active",
          currentPeriodEnd: RENEWS_AT,
        },
      },
    },
    trial: {
      label: "Pro, trialing",
      account: {
        signedIn: true,
        configured: true,
        user: DEMO_USER,
        balance: {
          credits: 18400,
          usdMillis: 18400,
          usageRemainingPercent: 92,
        },
        subscription: {
          subscribed: true,
          status: "trialing",
          trialEnd: TRIAL_ENDS_AT,
        },
      },
    },
    pastDue: {
      label: "Past due",
      account: {
        signedIn: true,
        configured: true,
        user: DEMO_USER,
        balance: {
          credits: 12800,
          usdMillis: 12800,
          usageRemainingPercent: 100,
        },
        subscription: { subscribed: true, status: "past_due" },
      },
    },
    signedOut: {
      label: "Signed out",
      account: { signedIn: false, configured: true },
    },
  };

export const BILLING_DEMO_ORDER: BillingDemoKey[] = [
  "free",
  "pro",
  "trial",
  "pastDue",
  "freeLow",
  "signedOut",
];

let forced: BillingDemoPlan | null = null;

function subscribe(onChange: () => void) {
  window.addEventListener(BILLING_DEMO_EVENT, onChange);
  return () => window.removeEventListener(BILLING_DEMO_EVENT, onChange);
}

/** The forced billing variant, or null while showing real account data. */
export function useForcedBillingPlan(): BillingDemoPlan | null {
  return useSyncExternalStore(
    subscribe,
    () => forced,
    () => null,
  );
}

function set(next: BillingDemoPlan | null) {
  forced = next;
  window.dispatchEvent(new Event(BILLING_DEMO_EVENT));
}

function isKey(value: string): value is BillingDemoKey {
  return value in BILLING_DEMO_FIXTURES;
}

export function registerBillingDemo() {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__billingDemo = (
    plan?: BillingDemoPlan | "off" | false,
  ) => {
    if (plan === false || plan === "off") {
      set(null);
      return "Billing demo off. Showing real account data.";
    }
    if (plan === undefined) {
      const states = [...BILLING_DEMO_ORDER, "all"].join('", "');
      return [
        `Open Account → Billing, then: __billingDemo("${BILLING_DEMO_ORDER[0]}")`,
        `States: "${states}"`,
        '"all" stacks every variant. __billingDemo("off") to reset.',
        forced ? `Currently showing: ${forced}` : "Currently: real data.",
      ].join("\n");
    }
    if (plan === "all") {
      set("all");
      return 'Stacking every billing variant. __billingDemo("off") to reset.';
    }
    if (!isKey(plan)) {
      return `Unknown plan "${plan}". Try ${BILLING_DEMO_ORDER.join(", ")}, all, off.`;
    }
    set(plan);
    return `Billing showing "${BILLING_DEMO_FIXTURES[plan].label}". __billingDemo("off") to reset.`;
  };
}
