import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDepletedBalanceAction } from "../lib/billing-actions";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  osAccountsChangePlan: vi.fn(),
  osAccountsOpenPortal: vi.fn(),
  osAccountsUpgrade: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  osAccountsChangePlan: mocks.osAccountsChangePlan,
  osAccountsOpenPortal: mocks.osAccountsOpenPortal,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
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
  });

  it("subscribes an unsubscribed (Free) user through checkout", async () => {
    const outcome = await runDepletedBalanceAction(account({ subscription: { subscribed: false } }));

    expect(outcome).toBe("opened_browser");
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledOnce();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("upgrades a Pro subscriber in place to Max", async () => {
    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "pro" } }),
    );

    expect(outcome).toBe("changed_plan");
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledWith("max");
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

  it("falls back to the in-place upgrade when a top-up is gated behind Max", async () => {
    mocks.osAccountsOpenPortal.mockRejectedValueOnce({
      code: "top_up_requires_max",
      message: "Buying credits requires the Max plan.",
    });

    const outcome = await runDepletedBalanceAction(
      account({ subscription: { subscribed: true, status: "active", plan: "max" } }),
    );

    expect(outcome).toBe("changed_plan");
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledWith("max");
  });

  it("rethrows other failures untouched", async () => {
    mocks.osAccountsUpgrade.mockRejectedValueOnce({ code: "network_error", message: "offline" });

    await expect(
      runDepletedBalanceAction(account({ subscription: { subscribed: false } })),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });
});
