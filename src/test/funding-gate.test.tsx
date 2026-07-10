import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FundingGate } from "../components/account/FundingGate";
import { clearMaxGrantWait } from "../lib/max-upgrade";
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
    clearMaxGrantWait();
    vi.clearAllMocks();
    mocks.osAccountsChangePlan.mockResolvedValue({ subscribed: true, plan: "max" });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.osAccountsUpgradeSession.mockResolvedValue(undefined);
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
    "Max is $100 per month. A secure Stripe page will open in your browser so you can review and confirm the prorated charge.";

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

  it("opens a hosted upgrade session and starts the grant poll after confirmation", async () => {
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

    // The CTA opens the charge confirm; no plan change starts until confirmed.
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(await screen.findByText(MAX_CONFIRM_BODY)).toBeInTheDocument();
    expect(mocks.osAccountsUpgradeSession).not.toHaveBeenCalled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Upgrade now" }));
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledWith("max");
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    expect(await screen.findAllByText("Waiting for you to confirm in the browser")).toHaveLength(2);
    // A successful PATCH is not proof that the credit grant landed.
    expect(screen.queryByText("Max is active.")).toBeNull();
    expect(screen.queryByText("Top up credits")).toBeNull();
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it("falls back to PATCH when hosted upgrade is unavailable", async () => {
    const user = userEvent.setup();
    const onRefresh = renderDepletedProGate();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "plan_not_enabled",
      message: "That plan is not available yet.",
    });

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledOnce();
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledOnce();
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledWith("max");
    expect(
      await screen.findByText("Upgrade started. Waiting for payment confirmation."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Max is active.")).toBeNull();
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it("cancelling the upgrade confirm never changes the plan", async () => {
    const user = userEvent.setup();
    renderDepletedProGate();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await screen.findByText(MAX_CONFIRM_BODY);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgradeSession).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(screen.queryByText(MAX_CONFIRM_BODY)).toBeNull();
    // Back on the prompt, ready to try again.
    expect(screen.getByRole("button", { name: "Upgrade to Max" })).toBeInTheDocument();
  });

  it("keeps the confirm open showing the failure when the plan change fails", async () => {
    const user = userEvent.setup();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "network_error",
      message: "Could not reach OS Accounts.",
    });
    mocks.osAccountsChangePlan.mockRejectedValueOnce({
      code: "network_error",
      message: "Could not reach OS Accounts.",
    });
    renderDepletedProGate();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    expect(await screen.findByText("Could not reach OS Accounts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade now" })).toBeEnabled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("announces Max only after a refreshed account snapshot shows the grant", async () => {
    const user = userEvent.setup();
    const depletedProAccount: AccountStatus = {
      ...baseAccount,
      balance: { credits: -1, usdMillis: -1 },
      subscription: { subscribed: true, status: "active", plan: "pro" },
    };
    const optimisticMaxAccount: AccountStatus = {
      ...depletedProAccount,
      subscription: { subscribed: true, status: "active", plan: "max" },
    };
    const grantedMaxAccount: AccountStatus = {
      ...optimisticMaxAccount,
      balance: { credits: 50_000, usdMillis: 50_000 },
    };
    let resolveGrantRefresh: ((account: AccountStatus) => void) | undefined;
    const onRefresh = vi.fn<() => Promise<AccountStatus | undefined>>(
      () =>
        new Promise((resolve) => {
          resolveGrantRefresh = resolve;
        }),
    );
    const view = render(
      <FundingGate account={depletedProAccount} onRefresh={onRefresh} onSignOut={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    expect(await screen.findAllByText("Waiting for you to confirm in the browser")).toHaveLength(2);
    expect(screen.queryByText("Max is active.")).toBeNull();

    view.rerender(
      <FundingGate account={optimisticMaxAccount} onRefresh={onRefresh} onSignOut={vi.fn()} />,
    );
    expect(
      await screen.findByText("Upgrade started. Waiting for payment confirmation."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Max is active.")).toBeNull();

    view.rerender(
      <FundingGate account={grantedMaxAccount} onRefresh={onRefresh} onSignOut={vi.fn()} />,
    );
    resolveGrantRefresh?.(grantedMaxAccount);

    expect(await screen.findByText("Max is active.")).toBeInTheDocument();
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledWith("max");
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("shows billing recovery when payment is not confirmed before polling ends", async () => {
    vi.useFakeTimers();
    const optimisticMaxAccount: AccountStatus = {
      ...baseAccount,
      balance: { credits: -1, usdMillis: -1 },
      subscription: { subscribed: true, status: "active", plan: "max" },
    };
    const onRefresh = vi.fn(async () => optimisticMaxAccount);

    try {
      const depletedProAccount: AccountStatus = {
        ...baseAccount,
        balance: { credits: -1, usdMillis: -1 },
        subscription: { subscribed: true, status: "active", plan: "pro" },
      };
      const view = render(
        <FundingGate account={depletedProAccount} onRefresh={onRefresh} onSignOut={vi.fn()} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Max" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Upgrade now" }));
        await Promise.resolve();
      });
      expect(screen.getAllByText("Waiting for you to confirm in the browser")).toHaveLength(2);

      view.rerender(
        <FundingGate account={optimisticMaxAccount} onRefresh={onRefresh} onSignOut={vi.fn()} />,
      );
      expect(
        screen.getByText("Upgrade started. Waiting for payment confirmation."),
      ).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(35_000);
      });

      expect(
        screen.getByText("Payment not confirmed yet. Check billing in your account portal."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Max is active.")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Open billing" }));
      expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();

      view.rerender(
        <FundingGate
          account={{
            ...optimisticMaxAccount,
            balance: { credits: 50_000, usdMillis: 50_000 },
          }}
          onRefresh={onRefresh}
          onSignOut={vi.fn()}
        />,
      );
      expect(screen.getByText("Max is active.")).toBeInTheDocument();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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
