import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FundingGate } from "../components/account/FundingGate";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  osAccountsOpenPortal: vi.fn(),
  osAccountsUpgrade: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  osAccountsOpenPortal: mocks.osAccountsOpenPortal,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
}));

const baseAccount: AccountStatus = {
  signedIn: true,
  configured: true,
  user: { id: "usr_123", handle: "alex", displayName: "Alex" },
  balance: { credits: 0, usdMillis: 0 },
  subscription: { subscribed: false },
};

function renderFundingGate(account: AccountStatus = baseAccount) {
  return render(
    <FundingGate account={account} onRefresh={vi.fn(async () => account)} onSignOut={vi.fn()} />,
  );
}

describe("FundingGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
  });

  it("asks users with no credits to upgrade, not add credits", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(
      <FundingGate
        account={baseAccount}
        onRefresh={vi.fn(async () => baseAccount)}
        onSignOut={onSignOut}
      />,
    );

    expect(screen.getByRole("heading", { name: "Upgrade to continue" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start free trial" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "How your free trial works" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledWith("pro");
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    await screen.findByText("Waiting for your upgrade");

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("offers Max checkout for those who want to go beyond Pro", async () => {
    const user = userEvent.setup();
    renderFundingGate();

    expect(screen.getByText("Want to go beyond Pro?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledWith("max");
    await screen.findByText("Waiting for your upgrade");

    // Reopening checkout keeps the plan the user picked.
    await user.click(screen.getByRole("button", { name: "Reopen checkout" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenLastCalledWith("max");
  });

  it("opens billing management for past-due subscriptions", async () => {
    const user = userEvent.setup();
    renderFundingGate({
      ...baseAccount,
      subscription: { subscribed: true, status: "past_due" },
    });

    expect(screen.getByRole("heading", { name: "Update billing" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage billing" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("opens billing management for incomplete subscriptions", async () => {
    const user = userEvent.setup();
    renderFundingGate({
      ...baseAccount,
      subscription: { subscribed: true, status: "incomplete" },
    });

    expect(screen.getByRole("heading", { name: "Update billing" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Upgrade to continue" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage billing" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("opens the account portal for subscribed users below zero credits", async () => {
    const user = userEvent.setup();
    renderFundingGate({
      ...baseAccount,
      balance: { credits: -1, usdMillis: -1 },
      subscription: { subscribed: true, status: "active" },
    });

    expect(screen.getByRole("heading", { name: "Top up credits" })).toBeInTheDocument();
    expect(
      screen.getByText("Your credit balance is below zero. Top up credits to keep using June."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Top up credits" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("does not show top-up copy for subscribed users with positive credits", async () => {
    const user = userEvent.setup();
    renderFundingGate({
      ...baseAccount,
      balance: { credits: 1200, usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    });

    expect(screen.getByRole("heading", { name: "Upgrade to continue" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Top up credits" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledOnce();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("lets a waiting account update be checked or reopened", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn(async () => baseAccount);
    render(<FundingGate account={baseAccount} onRefresh={onRefresh} onSignOut={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    await screen.findByText("Waiting for your upgrade");

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Reopen checkout" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledTimes(2);
  });

  it("polls account refresh while the gate is visible", async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn(async () => baseAccount);
    try {
      render(<FundingGate account={baseAccount} onRefresh={onRefresh} onSignOut={vi.fn()} />);

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
