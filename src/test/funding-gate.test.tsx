import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FundingGate,
  FundingGateBanner,
  FundingGateDialog,
} from "../components/account/FundingGate";
import { Dialog } from "../components/ui/Dialog";
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
    mocks.osAccountsChangePlan.mockResolvedValue({ subscribed: true, plan: "max" });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
  });

  it("presents the existing funding content in a dismissible dialog", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <FundingGateDialog
        account={baseAccount}
        onRefresh={vi.fn(async () => baseAccount)}
        onSignOut={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Credits needed" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Upgrade to continue" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("dismisses the funding dialog with Escape", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <FundingGateDialog
        account={baseAccount}
        onRefresh={vi.fn(async () => baseAccount)}
        onSignOut={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("lets Escape close the nested plan confirmation before the funding dialog", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <FundingGateDialog
        account={{
          ...baseAccount,
          balance: { credits: -1, usdMillis: -1 },
          subscription: { subscribed: true, status: "active", plan: "pro" },
        }}
        onRefresh={vi.fn(async () => baseAccount)}
        onSignOut={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByRole("dialog", { name: "Credits needed" })).toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses independently when another app dialog is open", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <>
        <Dialog open onClose={vi.fn()} title="Other dialog">
          <p>Other content</p>
        </Dialog>
        <FundingGateDialog
          account={baseAccount}
          onRefresh={vi.fn(async () => baseAccount)}
          onSignOut={vi.fn()}
          onDismiss={onDismiss}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("uses the same upgrade action in the persistent banner presentation", () => {
    render(
      <FundingGateBanner
        account={baseAccount}
        onRefresh={vi.fn(async () => baseAccount)}
        onSignOut={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeInTheDocument();
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

  it("opens the account portal for Max subscribers below zero credits", async () => {
    const user = userEvent.setup();
    renderFundingGate({
      ...baseAccount,
      balance: { credits: -1, usdMillis: -1 },
      subscription: { subscribed: true, status: "active", plan: "max" },
    });

    expect(screen.getByRole("heading", { name: "Top up credits" })).toBeInTheDocument();
    expect(
      screen.getByText("Your credit balance is below zero. Top up credits to keep using June."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Top up credits" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  const MAX_CONFIRM_BODY =
    "Max is $100 per month, charged to your saved card now. Your billing cycle restarts today.";

  function renderDepletedProGate(onRefresh = vi.fn(async () => baseAccount)) {
    render(
      <FundingGate
        account={{
          ...baseAccount,
          balance: { credits: -1, usdMillis: -1 },
          subscription: { subscribed: true, status: "active", plan: "pro" },
        }}
        onRefresh={onRefresh}
        onSignOut={vi.fn()}
      />,
    );
    return onRefresh;
  }

  it("offers a depleted Pro subscriber exactly one path: upgrade to Max in place", async () => {
    const user = userEvent.setup();
    const onRefresh = renderDepletedProGate();

    expect(screen.getByRole("heading", { name: "Upgrade to Max" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "You have used your Pro credits for this cycle. Upgrade to Max for 5x the monthly usage.",
      ),
    ).toBeInTheDocument();
    // No top-up affordance anywhere for Pro.
    expect(screen.queryByRole("button", { name: "Top up credits" })).not.toBeInTheDocument();
    expect(screen.queryByText("Want to go beyond Pro?")).not.toBeInTheDocument();

    // The CTA opens the charge confirm; nothing is billed until confirmed.
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(await screen.findByText(MAX_CONFIRM_BODY)).toBeInTheDocument();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Upgrade now" }));
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledWith("max");
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledTimes(1);
    // In-place upgrade never opens a browser or hits checkout.
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    // The credit grant lands via webhook after the PATCH: the gate flips to a
    // waiting panel and polls the account until the balance reflects Max. The
    // waiting state wins over branch derivation, so the mid-upgrade snapshot
    // (plan Max, credits still depleted) can never re-derive as a top-up
    // prompt.
    expect(await screen.findByRole("heading", { name: "Setting up Max" })).toBeInTheDocument();
    expect(
      screen.getByText("Your upgrade went through. Your new credits are on the way."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Top up credits")).toBeNull();
    // Single ordered refresh path: only the poll's immediate tick runs, never
    // a parallel fire-and-forget refresh that could resolve out of order and
    // overwrite the poll's fresher snapshot with a stale pre-grant one.
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it("cancelling the upgrade confirm never charges", async () => {
    const user = userEvent.setup();
    renderDepletedProGate();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await screen.findByText(MAX_CONFIRM_BODY);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(screen.queryByText(MAX_CONFIRM_BODY)).toBeNull();
    // Back on the prompt, ready to try again.
    expect(screen.getByRole("button", { name: "Upgrade to Max" })).toBeInTheDocument();
  });

  it("keeps the confirm open showing the failure when the change errors", async () => {
    const user = userEvent.setup();
    mocks.osAccountsChangePlan.mockRejectedValueOnce({
      code: "network_error",
      message: "Could not reach OS Accounts.",
    });
    renderDepletedProGate();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    expect(await screen.findByText("Could not reach OS Accounts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade now" })).toBeEnabled();
  });

  it("recovers a stale plan-change rejection by refreshing, not erroring", async () => {
    const user = userEvent.setup();
    mocks.osAccountsChangePlan.mockRejectedValueOnce({
      code: "already_on_plan",
      message: "You are already on this plan.",
    });
    const onRefresh = renderDepletedProGate();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    // The gate refreshes and re-derives the right prompt; the stale-state
    // rejection never surfaces as an error message.
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(screen.queryByText("You are already on this plan.")).toBeNull();
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
