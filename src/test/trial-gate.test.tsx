import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrialGate } from "../components/account/TrialGate";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  checkout: {
    phase: "idle",
    usedPortalFallback: false,
    error: undefined as string | undefined,
    notice: undefined as string | undefined,
    start: vi.fn(),
    checkNow: vi.fn(),
  },
  osAccountsOpenPortal: vi.fn(),
}));

vi.mock("../lib/trial-checkout", () => ({
  useTrialCheckout: () => mocks.checkout,
}));

vi.mock("../lib/tauri", () => ({
  osAccountsOpenPortal: mocks.osAccountsOpenPortal,
}));

const baseAccount: AccountStatus = {
  signedIn: true,
  configured: true,
  user: { id: "usr_123", handle: "alex", displayName: "Alex" },
  balance: { usdMillis: 0 },
  subscription: { subscribed: false, trialPeriodDays: 14 },
};

function renderTrialGate(account: AccountStatus = baseAccount) {
  return render(
    <TrialGate
      account={account}
      onRefresh={vi.fn(async () => account)}
      onSignOut={vi.fn()}
    />,
  );
}

describe("TrialGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkout.phase = "idle";
    mocks.checkout.usedPortalFallback = false;
    mocks.checkout.error = undefined;
    mocks.checkout.notice = undefined;
    mocks.checkout.start.mockResolvedValue(undefined);
    mocks.checkout.checkNow.mockResolvedValue(undefined);
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
  });

  it("shows the fresh trial pitch and starts checkout", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(
      <TrialGate
        account={baseAccount}
        onRefresh={vi.fn(async () => baseAccount)}
        onSignOut={onSignOut}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Start your free trial" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "How your free trial works" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Due today: $0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start free trial" }));
    expect(mocks.checkout.start).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("lets a waiting checkout be checked or reopened", async () => {
    const user = userEvent.setup();
    mocks.checkout.phase = "waiting";
    renderTrialGate();

    expect(
      screen.getByRole("heading", {
        name: "Finish checkout in your browser",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for your trial to start"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(mocks.checkout.checkNow).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Reopen checkout" }));
    expect(mocks.checkout.start).toHaveBeenCalledOnce();
  });

  it("opens billing management for past-due subscriptions", async () => {
    const user = userEvent.setup();
    renderTrialGate({
      ...baseAccount,
      subscription: { subscribed: true, status: "past_due" },
    });

    expect(
      screen.getByRole("heading", { name: "Payment needed" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "How your free trial works" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage billing" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
  });

  it("offers resubscribe copy for canceled subscriptions", async () => {
    const user = userEvent.setup();
    renderTrialGate({
      ...baseAccount,
      subscription: { subscribed: false, status: "canceled" },
    });

    expect(
      screen.getByRole("heading", { name: "Welcome back" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Due today: $0")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resubscribe" }));
    expect(mocks.checkout.start).toHaveBeenCalledOnce();
  });

  it("polls account refresh while the gate is visible", async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn(async () => baseAccount);
    try {
      render(
        <TrialGate
          account={baseAccount}
          onRefresh={onRefresh}
          onSignOut={vi.fn()}
        />,
      );

      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(onRefresh).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
