import { describe, expect, it } from "vitest";
import { shouldBlockOnSignIn, shouldBlockOnTrial } from "../lib/account-gate";
import type { AccountStatus } from "../lib/tauri";

describe("shouldBlockOnSignIn", () => {
  it("blocks when the user is not signed in", () => {
    expect(shouldBlockOnSignIn({ signedIn: false, configured: true })).toBe(
      true,
    );
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

describe("shouldBlockOnTrial", () => {
  function signedIn(overrides: Partial<AccountStatus> = {}): AccountStatus {
    return {
      signedIn: true,
      configured: true,
      user: { id: "usr_1", handle: "jakub" },
      ...overrides,
    };
  }

  it("never blocks signed-out users (the sign-in gate owns that)", () => {
    expect(shouldBlockOnTrial({ signedIn: false, configured: true })).toBe(
      false,
    );
  });

  it("blocks a fresh signup with no subscription", () => {
    expect(
      shouldBlockOnTrial(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: false },
        }),
      ),
    ).toBe(true);
  });

  it("blocks credit holders without a subscription — membership is mandatory", () => {
    expect(
      shouldBlockOnTrial(
        signedIn({
          balance: { credits: 5000, usdMillis: 5000 },
          subscription: { subscribed: false },
        }),
      ),
    ).toBe(true);
  });

  it("blocks a cancelled subscriber even with unspent credits", () => {
    expect(
      shouldBlockOnTrial(
        signedIn({
          balance: { credits: 1200, usdMillis: 1200 },
          subscription: { subscribed: false, status: "canceled" },
        }),
      ),
    ).toBe(true);
  });

  it("allows a trialing subscriber even at zero balance", () => {
    expect(
      shouldBlockOnTrial(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: true, status: "trialing" },
        }),
      ),
    ).toBe(false);
  });

  it("allows an active subscriber even at zero balance (credit-line floor)", () => {
    expect(
      shouldBlockOnTrial(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: true, status: "active" },
        }),
      ),
    ).toBe(false);
  });

  it("blocks a past-due subscriber with no credits left", () => {
    expect(
      shouldBlockOnTrial(
        signedIn({
          balance: { credits: 0, usdMillis: 0 },
          subscription: { subscribed: true, status: "past_due" },
        }),
      ),
    ).toBe(true);
  });

  it("blocks when the subscription state is unknown until a refresh resolves it", () => {
    expect(shouldBlockOnTrial(signedIn({ balance: { usdMillis: 0 } }))).toBe(
      true,
    );
    expect(shouldBlockOnTrial(signedIn())).toBe(true);
  });
});
