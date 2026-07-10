import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDepletedBalanceAction } from "../lib/billing-actions";
import { isTopUpRequiresMaxError } from "../lib/errors";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  osAccountsChangePlan: vi.fn(),
  osAccountsOpenPortal: vi.fn(),
  osAccountsUpgrade: vi.fn(),
  osAccountsUpgradeSession: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  osAccountsChangePlan: mocks.osAccountsChangePlan,
  osAccountsOpenPortal: mocks.osAccountsOpenPortal,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
  osAccountsUpgradeSession: mocks.osAccountsUpgradeSession,
}));

function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    signedIn: true,
    configured: true,
    user: { id: "usr_1", handle: "alex" },
    ...overrides,
  };
}

describe("runDepletedBalanceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.osAccountsChangePlan.mockResolvedValue({ subscribed: true, plan: "max" });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.osAccountsUpgradeSession.mockResolvedValue(undefined);
  });

  it("subscribes an unsubscribed (Free) user through checkout", async () => {
    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: false } }),
    );

    expect(outcome).toBe("opened_browser");
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledWith();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("opens a hosted Max upgrade session without changing the plan directly", async () => {
    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "pro" } }),
    );

    expect(outcome).toBe("opened_upgrade_session");
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledWith("max");
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it.each([
    "upgrade_session_unavailable",
    "plan_not_enabled",
    "network_error",
  ])("falls back to the plan-change endpoint when hosted upgrade fails with %s", async (code) => {
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({ code, message: "unavailable" });

    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "pro" } }),
    );

    expect(outcome).toBe("changed_plan");
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledWith("max");
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledOnce();
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledWith("max");
  });

  it("dispatches an explicit Max confirmation without reclassifying it", async () => {
    // App validates that the latest snapshot still supports this captured
    // intent before dispatch. From that point, the helper must use the intent
    // exactly instead of deriving a different checkout from the snapshot.
    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: false } }),
      "upgrade_to_max",
      "max",
    );

    expect(outcome).toBe("opened_upgrade_session");
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledWith("max");
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("opens the portal for a Max subscriber to top up", async () => {
    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "max" } }),
    );

    expect(outcome).toBe("opened_browser");
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  it("reports upgrade_required for a Max-gated top-up and never auto-buys a plan change", async () => {
    // The server gating a top-up behind Max means the local Max snapshot was
    // stale. A plan change must come from an explicit user click on the
    // upgrade prompt (which the caller surfaces after a refresh), never from
    // this error handler.
    mocks.osAccountsOpenPortal.mockRejectedValueOnce({
      code: "top_up_requires_max",
      message: "Buying credits requires the Max plan.",
    });

    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "max" } }),
    );

    expect(outcome).toBe("upgrade_required");
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("recognises the numeric accounts envelope for the Max gate", async () => {
    // The backend envelope is numeric: top_up_requires_max is error code 3002.
    mocks.osAccountsOpenPortal.mockRejectedValueOnce({
      error_code: 3002,
      message: "Buying credits requires the Max plan.",
    });

    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "max" } }),
    );

    expect(outcome).toBe("upgrade_required");
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  it("treats already_on_plan as a completed change from a stale snapshot", async () => {
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "already_on_plan",
      message: "You are already on this plan.",
    });

    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "pro" } }),
    );

    expect(outcome).toBe("changed_plan");
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("returns to the subscribe prompt when the plan change needs a subscription", async () => {
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "subscription_required",
      message: "You need an active subscription to change plans.",
    });

    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "pro" } }),
    );

    expect(outcome).toBe("subscribe_required");
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("rethrows other failures untouched", async () => {
    mocks.osAccountsUpgrade.mockRejectedValueOnce({ code: "network_error", message: "offline" });

    await expect(
      runDepletedBalanceAction(account({ subscription: { subscribed: false } })),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();

    // A hosted 501 falls back to PATCH, whose failure is still surfaced.
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "plan_not_enabled",
      message: "That plan is not available yet.",
    });
    mocks.osAccountsChangePlan.mockRejectedValueOnce({
      code: "plan_not_enabled",
      message: "That plan is not available yet.",
    });
    await expect(
      runDepletedBalanceAction(
        account({ subscription: { subscribed: true, status: "active", plan: "pro" } }),
      ),
    ).rejects.toMatchObject({ code: "plan_not_enabled" });
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledTimes(1);
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledOnce();
  });
});

describe("isTopUpRequiresMaxError", () => {
  it("matches the structured Rust code", () => {
    expect(
      isTopUpRequiresMaxError({
        code: "top_up_requires_max",
        message: "Buying credits requires the Max plan.",
      }),
    ).toBe(true);
  });

  it("matches the numeric accounts envelope (3002)", () => {
    expect(isTopUpRequiresMaxError({ error_code: 3002, message: "x" })).toBe(true);
    expect(isTopUpRequiresMaxError({ code: 3002 })).toBe(true);
  });

  it("falls back to the canonical message", () => {
    expect(
      isTopUpRequiresMaxError({
        code: "request_failed",
        message: "Buying credits requires the Max plan.",
      }),
    ).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isTopUpRequiresMaxError({ code: "request_failed", message: "nope" })).toBe(false);
    expect(isTopUpRequiresMaxError({ error_code: 3001, message: "token expired" })).toBe(false);
    expect(isTopUpRequiresMaxError("offline")).toBe(false);
    expect(isTopUpRequiresMaxError(undefined)).toBe(false);
  });
});
