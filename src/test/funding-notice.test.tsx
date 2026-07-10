import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FundingChip, FundingNotice } from "../components/account/FundingNotice";
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

function renderFundingNotice(account: AccountStatus = baseAccount) {
  return render(<FundingNotice account={account} onRefresh={vi.fn(async () => account)} />);
}

describe("FundingNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.osAccountsChangePlan.mockResolvedValue({ subscribed: true, plan: "max" });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
  });

  it("renders as a persistent notice with no dismiss affordance", () => {
    renderFundingNotice();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /not now|dismiss|close/i })).toBeNull();
  });

  it("asks users with no credits to upgrade, not add credits", async () => {
    const user = userEvent.setup();
    renderFundingNotice();

    expect(
      screen.getByText("Your starter credits are used up. Upgrade to keep using June."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledWith("pro");
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    await screen.findByText("Waiting for your upgrade");
  });

  it("offers Max checkout for those who want to go beyond Pro", async () => {
    const user = userEvent.setup();
    renderFundingNotice();

    await user.click(screen.getByRole("button", { name: "Or go Max" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledWith("max");
    await screen.findByText("Waiting for your upgrade");

    // Reopening checkout keeps the plan the user picked.
    await user.click(screen.getByRole("button", { name: "Reopen checkout" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenLastCalledWith("max");
  });

  it("opens billing management for past-due subscriptions", async () => {
    const user = userEvent.setup();
    renderFundingNotice({
      ...baseAccount,
      subscription: { subscribed: true, status: "past_due" },
    });

    expect(
      screen.getByText("Your payment needs attention. Update billing to keep using June."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage billing" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("opens billing management for incomplete subscriptions", async () => {
    const user = userEvent.setup();
    renderFundingNotice({
      ...baseAccount,
      subscription: { subscribed: true, status: "incomplete" },
    });

    expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage billing" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("opens the account portal for Max subscribers below zero credits", async () => {
    const user = userEvent.setup();
    renderFundingNotice({
      ...baseAccount,
      balance: { credits: -1, usdMillis: -1 },
      subscription: { subscribed: true, status: "active", plan: "max" },
    });

    expect(
      screen.getByText("Your credit balance is below zero. Top up to keep using June."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Top up credits" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  const MAX_CONFIRM_BODY =
    "Max is $100 per month, charged to your saved card now. Your billing cycle restarts today.";

  function renderDepletedProNotice(onRefresh = vi.fn(async () => baseAccount)) {
    render(
      <FundingNotice
        account={{
          ...baseAccount,
          balance: { credits: -1, usdMillis: -1 },
          subscription: { subscribed: true, status: "active", plan: "pro" },
        }}
        onRefresh={onRefresh}
      />,
    );
    return onRefresh;
  }

  it("offers a depleted Pro subscriber exactly one path: upgrade to Max in place", async () => {
    const user = userEvent.setup();
    const onRefresh = renderDepletedProNotice();

    expect(
      screen.getByText(
        "You have used your Pro credits for this cycle. Max has 5x the monthly usage.",
      ),
    ).toBeInTheDocument();
    // No top-up or second-plan affordance anywhere for Pro.
    expect(screen.queryByRole("button", { name: "Top up credits" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Or go Max" })).not.toBeInTheDocument();

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
    // The credit grant lands via webhook after the PATCH: the notice flips to
    // a waiting row and polls the account until the balance reflects Max. The
    // waiting state wins over branch derivation, so the mid-upgrade snapshot
    // (plan Max, credits still depleted) can never re-derive as a top-up
    // prompt.
    expect(
      await screen.findByText("Your upgrade went through. Your new credits are on the way."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Top up credits")).toBeNull();
    // Single ordered refresh path: only the poll's immediate tick runs, never
    // a parallel fire-and-forget refresh that could resolve out of order and
    // overwrite the poll's fresher snapshot with a stale pre-grant one.
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it("cancelling the upgrade confirm never charges", async () => {
    const user = userEvent.setup();
    renderDepletedProNotice();

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
    renderDepletedProNotice();

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
    const onRefresh = renderDepletedProNotice();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    // The notice refreshes and re-derives the right prompt; the stale-state
    // rejection never surfaces as an error message.
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(screen.queryByText("You are already on this plan.")).toBeNull();
  });

  it("does not show top-up copy for subscribed users with positive credits", async () => {
    const user = userEvent.setup();
    renderFundingNotice({
      ...baseAccount,
      balance: { credits: 1200, usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    });

    expect(screen.queryByRole("button", { name: "Top up credits" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledOnce();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("lets a waiting account update be checked or reopened", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn(async () => baseAccount);
    render(<FundingNotice account={baseAccount} onRefresh={onRefresh} />);

    await user.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    await screen.findByText("Waiting for your upgrade");

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Reopen checkout" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledTimes(2);
  });

  it("polls account refresh while the notice is visible", async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn(async () => baseAccount);
    try {
      render(<FundingNotice account={baseAccount} onRefresh={onRefresh} />);

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

describe("FundingChip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.osAccountsChangePlan.mockResolvedValue({ subscribed: true, plan: "max" });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
  });

  function revealOf(container: HTMLElement) {
    const reveal = container.querySelector(".funding-chip-reveal");
    expect(reveal).not.toBeNull();
    return reveal as HTMLElement;
  }

  it("expands in place to reveal the same funding affordance", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <FundingChip account={baseAccount} onRefresh={vi.fn(async () => baseAccount)} />,
    );

    const chip = screen.getByRole("button", { name: "Out of credits" });
    // Collapsed: the reveal stays mounted for the height animation but is
    // inert, so its actions are unreachable.
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(revealOf(container)).toHaveAttribute("inert");

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(revealOf(container)).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeInTheDocument();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(revealOf(container)).toHaveAttribute("inert");
  });

  it("collapses on an outside click and on Escape", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <FundingChip account={baseAccount} onRefresh={vi.fn(async () => baseAccount)} />
      </>,
    );

    const chip = screen.getByRole("button", { name: "Out of credits" });
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(chip).toHaveAttribute("aria-expanded", "false");

    await user.click(chip);
    await user.keyboard("{Escape}");
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("stays expanded while the Max-upgrade confirm is open", async () => {
    const user = userEvent.setup();
    render(
      <FundingChip
        account={{
          ...baseAccount,
          balance: { credits: -1, usdMillis: -1 },
          subscription: { subscribed: true, status: "active", plan: "pro" },
        }}
        onRefresh={vi.fn(async () => baseAccount)}
      />,
    );

    const chip = screen.getByRole("button", { name: "Out of credits" });
    await user.click(chip);
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    const confirm = await screen.findByRole("dialog", { name: "Upgrade to Max?" });

    // Clicking inside the portaled confirm dialog is not an outside click.
    await user.click(confirm);
    expect(chip).toHaveAttribute("aria-expanded", "true");

    // Escape closes the confirm first; the chip stays open for the next step.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Upgrade to Max?" })).toBeNull(),
    );
    expect(chip).toHaveAttribute("aria-expanded", "true");
  });
});
