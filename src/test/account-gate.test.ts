import { describe, expect, it } from "vitest";
import {
  depletedBalanceAction,
  depletedBalanceActionLabel,
  isOnMaxPlan,
  shouldOpenPortalForDepletedBalance,
  shouldBlockOnFunding,
  shouldBlockOnSignIn,
} from "../lib/account-gate";
import type { AccountStatus } from "../lib/tauri";

describe("shouldBlockOnSignIn", () => {
  it("blocks when the user is not signed in", () => {
    expect(shouldBlockOnSignIn({ signedIn: false, configured: true })).toBe(true);
  });

  it("allows when the user is signed in", () => {
    expect(
      shouldBlockOnSignIn({
        signedIn: true,
        configured: true,
        user: { id: "usr_1", handle: "jakub" },
        balance: { usdMillis: 0 },
      }),
    ).toBe(false);
  });
});

describe("shouldBlockOnFunding", () => {
  function signedIn(overrides: Partial<AccountStatus> = {}): AccountStatus {
    return {
      signedIn: true,
      configured: true,
      user: { id: "usr_1", handle: "jakub" },
      ...overrides,
    };
  }

  it("never blocks signed-out users (the sign-in gate owns that)", () => {
    expect(shouldBlockOnFunding({ signedIn: false, configured: true })).toBe(false);
  });

  it("blocks an account with known zero credits and no subscription", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: false },
        }),
      ),
    ).toBe(true);
  });

  it("allows credit holders without a subscription", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 5000, usdMillis: 5000 },
          subscription: { subscribed: false },
        }),
      ),
    ).toBe(false);
  });

  it("allows canceled subscribers with unspent credits", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 1200, usdMillis: 1200 },
          subscription: { subscribed: false, status: "canceled" },
        }),
      ),
    ).toBe(false);
  });

  it("allows a trialing subscriber even at zero balance", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: true, status: "trialing" },
        }),
      ),
    ).toBe(false);
  });

  it("allows an active subscriber even at zero balance (credit-line floor)", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: true, status: "active" },
        }),
      ),
    ).toBe(false);
  });

  it("blocks a negative balance even for a live subscriber", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: -1, usdMillis: -1 },
          subscription: { subscribed: true, status: "active" },
        }),
      ),
    ).toBe(true);
  });

  it("blocks a negative balance while subscription state is unknown", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: -1, usdMillis: -1 },
        }),
      ),
    ).toBe(true);
  });

  it("blocks a past-due subscriber with no credits left", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: true, status: "past_due" },
        }),
      ),
    ).toBe(true);
  });

  it("blocks explicit non-live subscription statuses with no credits left", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: true, status: "incomplete" },
        }),
      ),
    ).toBe(true);
  });

  it("allows zero-credit users while subscription state is unknown", () => {
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
        }),
      ),
    ).toBe(false);
    expect(
      shouldBlockOnFunding(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: true },
        }),
      ),
    ).toBe(false);
  });

  it("allows unknown credit snapshots and lets metered actions decide", () => {
    expect(shouldBlockOnFunding(signedIn({ balance: { usdMillis: 0 } }))).toBe(false);
    expect(shouldBlockOnFunding(signedIn())).toBe(false);
  });
});

describe("isOnMaxPlan", () => {
  it("is true only for an active Max subscription", () => {
    expect(
      isOnMaxPlan({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active", plan: "max" },
      }),
    ).toBe(true);
  });

  it("treats a Pro slug and legacy (slug-less) rows as not Max", () => {
    expect(
      isOnMaxPlan({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active", plan: "pro" },
      }),
    ).toBe(false);
    // Legacy subscription rows predate plan tiers and are all Pro.
    expect(
      isOnMaxPlan({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active" },
      }),
    ).toBe(false);
  });
});

describe("depletedBalanceAction", () => {
  it("subscribes unsubscribed users", () => {
    expect(
      depletedBalanceAction({
        signedIn: true,
        configured: true,
        subscription: { subscribed: false },
      }),
    ).toBe("subscribe");
  });

  it("upgrades Pro (and legacy) subscribers in place to Max", () => {
    expect(
      depletedBalanceAction({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active", plan: "pro" },
      }),
    ).toBe("upgrade_to_max");
    expect(
      depletedBalanceAction({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active" },
      }),
    ).toBe("upgrade_to_max");
  });

  it("tops up Max subscribers", () => {
    expect(
      depletedBalanceAction({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active", plan: "max" },
      }),
    ).toBe("top_up");
  });
});

describe("depletedBalanceActionLabel", () => {
  it("asks unsubscribed users to upgrade", () => {
    expect(
      depletedBalanceActionLabel({
        signedIn: true,
        configured: true,
        subscription: { subscribed: false },
      }),
    ).toBe("Upgrade");
  });

  it("asks Pro subscribers to upgrade to Max (only Max may buy credits)", () => {
    expect(
      depletedBalanceActionLabel({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active", plan: "pro" },
      }),
    ).toBe("Upgrade to Max");
  });

  it("asks Max subscribers to top up credits", () => {
    expect(
      depletedBalanceActionLabel({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active", plan: "max" },
      }),
    ).toBe("Top up credits");
  });
});

describe("shouldOpenPortalForDepletedBalance", () => {
  it("keeps unsubscribed users on checkout", () => {
    expect(
      shouldOpenPortalForDepletedBalance({
        signedIn: true,
        configured: true,
        subscription: { subscribed: false },
      }),
    ).toBe(false);
  });

  it("keeps Pro subscribers off the portal (they upgrade in place)", () => {
    expect(
      shouldOpenPortalForDepletedBalance({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active", plan: "pro" },
      }),
    ).toBe(false);
  });

  it("routes Max subscribers to the account portal", () => {
    expect(
      shouldOpenPortalForDepletedBalance({
        signedIn: true,
        configured: true,
        subscription: { subscribed: true, status: "active", plan: "max" },
      }),
    ).toBe(true);
  });
});
