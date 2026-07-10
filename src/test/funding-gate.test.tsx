import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FundingGate } from "../components/account/FundingGate";
import { beginMaxGrantWait, clearMaxGrantWait, currentMaxGrantWait } from "../lib/max-upgrade";
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

  const CHARGE_NOW_BODY =
    "Max is $100 per month, charged to your saved card now. Your billing cycle restarts today.";

  it("requires a second, charge-now confirm before falling back to PATCH", async () => {
    const user = userEvent.setup();
    renderDepletedProGate();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "plan_not_enabled",
      message: "That plan is not available yet.",
    });

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    // The capability signal swaps the dialog to the charge-now copy without
    // charging anything: hosted-copy consent never precedes a PATCH.
    expect(await screen.findByText(CHARGE_NOW_BODY)).toBeInTheDocument();
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledOnce();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Upgrade now" }));

    expect(mocks.osAccountsChangePlan).toHaveBeenCalledOnce();
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledWith("max");
    // The consented PATCH retry never re-runs the hosted transport.
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("Upgrade started. Waiting for payment confirmation."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Max is active.")).toBeNull();
  });

  it("cancelling the charge-now confirm resets the dialog to the hosted copy", async () => {
    const user = userEvent.setup();
    renderDepletedProGate();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "upgrade_session_unavailable",
      message: "Upgrade sessions are not available yet.",
    });

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));
    expect(await screen.findByText(CHARGE_NOW_BODY)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();

    // Reopening starts from the hosted consent again.
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(await screen.findByText(MAX_CONFIRM_BODY)).toBeInTheDocument();
    expect(screen.queryByText(CHARGE_NOW_BODY)).toBeNull();
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

  it("shows a transient hosted failure in the dialog without ever issuing a PATCH", async () => {
    const user = userEvent.setup();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "network_error",
      message: "Could not reach OS Accounts.",
    });
    renderDepletedProGate();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    // The dialog stays open as the retry affordance; a transient failure is
    // not a capability signal and never authorizes the charge-now transport.
    expect(await screen.findByText("Could not reach OS Accounts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade now" })).toBeEnabled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();

    // Retrying goes back to the hosted transport.
    await user.click(screen.getByRole("button", { name: "Upgrade now" }));
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledTimes(2);
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  it("re-derives the gate instead of polling when already_on_plan reveals a settled Max account", async () => {
    const user = userEvent.setup();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "already_on_plan",
      message: "You are already on this plan.",
    });
    // The refreshed snapshot is a long-settled Max account: the credit
    // balance has moved well away from the stale baseline, so no grant tied
    // to this confirm is coming and a poll could never succeed.
    const settledMaxAccount: AccountStatus = {
      ...baseAccount,
      balance: { credits: -800, usdMillis: -800 },
      subscription: { subscribed: true, status: "active", plan: "max" },
    };
    const onRefresh = renderDepletedProGate(vi.fn(async () => settledMaxAccount));

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    await waitFor(() => expect(screen.queryByText(MAX_CONFIRM_BODY)).toBeNull());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(currentMaxGrantWait()).toBeUndefined();
    expect(screen.queryByText("Upgrade started. Waiting for payment confirmation.")).toBeNull();
    expect(screen.queryByText("Waiting for payment confirmation")).toBeNull();
  });

  it("starts the grant poll when already_on_plan still looks pre-grant after one refresh", async () => {
    const user = userEvent.setup();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "already_on_plan",
      message: "You are already on this plan.",
    });
    // The refresh shows the plan flipped but credits sitting exactly at the
    // baseline: the payment-backed grant webhook has not landed yet.
    const optimisticMaxAccount: AccountStatus = {
      ...baseAccount,
      balance: { credits: -1, usdMillis: -1 },
      subscription: { subscribed: true, status: "active", plan: "max" },
    };
    renderDepletedProGate(vi.fn(async () => optimisticMaxAccount));

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    expect(
      await screen.findByText("Upgrade started. Waiting for payment confirmation."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Max is active.")).toBeNull();
    expect(currentMaxGrantWait()).toMatchObject({
      accountId: "usr_123",
      baselineCredits: -1,
      phase: "waiting",
    });
  });

  it("suppresses a second purchase when an upgrade wait already exists for the account", () => {
    // An upgrade begun on another surface (Billing settings, a depleted-note
    // banner) must survive this gate mounting fresh.
    beginMaxGrantWait(-1, "usr_123", "browser");
    renderFundingGate({
      ...baseAccount,
      balance: { credits: -1, usdMillis: -1 },
      subscription: { subscribed: true, status: "active", plan: "pro" },
    });

    expect(screen.getAllByText("Waiting for you to confirm in the browser")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Upgrade to Max" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
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

  it("keeps a retry path when the hosted round trip outlasts its poll window", async () => {
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

      // The 30s webhook window does not apply to a hosted round trip: the
      // user may still be reading the Stripe page.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(35_000);
      });
      expect(
        screen.getByText("Upgrade started. Waiting for payment confirmation."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/If you closed the Stripe page/)).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });

      // Non-terminal copy: the poll giving up is not a payment failure.
      expect(
        screen.getByText(
          "Still waiting for payment confirmation. If you closed the Stripe page, you can try again.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("Max is active.")).toBeNull();

      // The retry CTA stays alongside billing: reopening a hosted session
      // charges nothing until the Stripe confirm.
      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Max" }));
      expect(screen.getByText(MAX_CONFIRM_BODY)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

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
