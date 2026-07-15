import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FundingChip, FundingNotice } from "../components/account/FundingNotice";
import {
  beginMaxGrantWait,
  clearMaxGrantWait,
  currentMaxGrantWait,
  markMaxGrantWaitSlow,
} from "../lib/max-upgrade";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  osAccountsChangePlan: vi.fn(),
  osAccountsOpenPortal: vi.fn(),
  osAccountsUpgrade: vi.fn(),
  osAccountsUpgradeSession: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationCapabilities: vi.fn().mockResolvedValue({
    capabilities: {
      available: true,
      platform: "macos",
      shortcuts: true,
      paste: true,
      microphoneSelection: true,
      accessibilityPermission: true,
      systemAudio: true,
    },
  }),
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

function renderFundingNotice(account: AccountStatus = baseAccount) {
  return render(<FundingNotice account={account} onRefresh={vi.fn(async () => account)} />);
}

describe("FundingNotice", () => {
  beforeEach(() => {
    clearMaxGrantWait();
    vi.clearAllMocks();
    mocks.osAccountsChangePlan.mockResolvedValue({ subscribed: true, plan: "max" });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.osAccountsUpgradeSession.mockResolvedValue(undefined);
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
    "Max is $100 per month. A secure Stripe page will open in your browser to review and confirm. Your billing cycle restarts today.";
  const CHARGE_NOW_BODY =
    "Max is $100 per month, charged to your saved card now. Your billing cycle restarts today.";
  const BROWSER_STATUS = "Waiting for you to confirm in the browser";
  const WAITING_STATUS = "Upgrade started. Waiting for payment confirmation.";

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

  it("offers a depleted Pro subscriber exactly one path: a hosted upgrade to Max", async () => {
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

    // The CTA opens the confirm; nothing is dispatched until confirmed.
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(await screen.findByText(MAX_CONFIRM_BODY)).toBeInTheDocument();
    expect(mocks.osAccountsUpgradeSession).not.toHaveBeenCalled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Upgrade now" }));
    // The hosted transport opens a Stripe review in the browser; the PATCH
    // that charges immediately never runs under the hosted consent copy.
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledWith("max");
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledTimes(1);
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    // The waiting state wins over branch derivation, so the mid-upgrade
    // snapshot (plan Max, credits still depleted) can never re-derive as a
    // top-up prompt.
    expect(await screen.findByText(BROWSER_STATUS)).toBeInTheDocument();
    expect(screen.queryByText("Top up credits")).toBeNull();
    // Single ordered refresh path: only the poll's immediate tick runs, never
    // a parallel fire-and-forget refresh that could resolve out of order and
    // overwrite the poll's fresher snapshot with a stale pre-grant one.
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it("requires a second, charge-now confirm before falling back to PATCH", async () => {
    const user = userEvent.setup();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "upgrade_session_unavailable",
      message: "Upgrade sessions are not available yet.",
    });
    renderDepletedProNotice();

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
    expect(await screen.findByText(WAITING_STATUS)).toBeInTheDocument();
  });

  it("cancelling the charge-now confirm resets the dialog to the hosted copy", async () => {
    const user = userEvent.setup();
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "plan_not_enabled",
      message: "That plan is not available yet.",
    });
    renderDepletedProNotice();

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

  it("cancelling from the browser phase returns to the prompt without charging", async () => {
    const user = userEvent.setup();
    renderDepletedProNotice();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));
    expect(await screen.findByText(BROWSER_STATUS)).toBeInTheDocument();

    // Closing the Stripe page must not park the notice on a spinner for the
    // whole poll window; the still-Pro refreshed snapshot proves nothing was
    // charged, so the wait clears and the prompt returns.
    await user.click(screen.getByRole("button", { name: "I closed the Stripe page" }));

    expect(await screen.findByRole("button", { name: "Upgrade to Max" })).toBeInTheDocument();
    expect(currentMaxGrantWait()).toBeUndefined();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("keeps waiting on cancel when the refreshed snapshot shows the payment went through", async () => {
    const user = userEvent.setup();
    // The user pays on the Stripe page, then clicks the cancel affordance
    // anyway. The refreshed snapshot shows the plan flipped with the grant
    // still pending - the wait is the only signal suppressing pre-grant Max
    // claims, so it must survive the click as a waiting row.
    const confirmedPreGrant: AccountStatus = {
      ...baseAccount,
      balance: { credits: -1, usdMillis: -1 },
      subscription: { subscribed: true, status: "active", plan: "max" },
    };
    renderDepletedProNotice(vi.fn(async () => confirmedPreGrant));

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));
    expect(await screen.findByText(BROWSER_STATUS)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "I closed the Stripe page" }));

    expect(await screen.findByText(WAITING_STATUS)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade to Max" })).toBeNull();
    expect(currentMaxGrantWait()).toMatchObject({ accountId: "usr_123", phase: "waiting" });
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  it("adopts an upgrade wait started on another surface instead of offering a second purchase", () => {
    beginMaxGrantWait(-1, "usr_123", "browser");
    renderDepletedProNotice();

    expect(screen.getByText(BROWSER_STATUS)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade to Max" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  });

  it("keeps a retry path and the billing link when the hosted wait goes slow", async () => {
    const user = userEvent.setup();
    const slowWait = beginMaxGrantWait(-1, "usr_123", "browser");
    markMaxGrantWaitSlow(slowWait);
    renderDepletedProNotice();

    // Non-terminal copy: the poll giving up is not a payment failure.
    expect(
      screen.getByText(
        "Still waiting for payment confirmation. If you closed the Stripe page, you can try again.",
      ),
    ).toBeInTheDocument();
    // The retry reopens a hosted session, which charges nothing until the
    // Stripe confirm; the billing link stays alongside.
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(await screen.findByText(MAX_CONFIRM_BODY)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Open billing" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
  });

  it("cancelling the upgrade confirm never charges", async () => {
    const user = userEvent.setup();
    renderDepletedProNotice();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await screen.findByText(MAX_CONFIRM_BODY);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgradeSession).not.toHaveBeenCalled();
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
    renderDepletedProNotice();

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    // A transient failure is not a capability signal and never authorizes
    // the charge-now transport; the dialog stays open as the retry.
    expect(await screen.findByText("Could not reach OS Accounts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade now" })).toBeEnabled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();

    // Retrying goes back to the hosted transport.
    await user.click(screen.getByRole("button", { name: "Upgrade now" }));
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledTimes(2);
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  it("re-derives instead of polling when already_on_plan reveals a settled Max account", async () => {
    const user = userEvent.setup();
    // A slow wait left behind by an abandoned checkout must also clear, so
    // the retry cannot loop back into the waiting wall.
    const staleWait = beginMaxGrantWait(-1, "usr_123", "browser");
    markMaxGrantWaitSlow(staleWait);
    mocks.osAccountsUpgradeSession.mockRejectedValueOnce({
      code: "already_on_plan",
      message: "You are already on this plan.",
    });
    const settledMaxAccount: AccountStatus = {
      ...baseAccount,
      balance: { credits: -800, usdMillis: -800 },
      subscription: { subscribed: true, status: "active", plan: "max" },
    };
    const onRefresh = renderDepletedProNotice(vi.fn(async () => settledMaxAccount));

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    // One refresh, no poll, no error, and the stale wait is gone.
    await waitFor(() => expect(currentMaxGrantWait()).toBeUndefined());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("You are already on this plan.")).toBeNull();
    expect(screen.queryByText(WAITING_STATUS)).toBeNull();
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
    renderDepletedProNotice(vi.fn(async () => optimisticMaxAccount));

    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    expect(await screen.findByText(WAITING_STATUS)).toBeInTheDocument();
    expect(currentMaxGrantWait()).toMatchObject({
      accountId: "usr_123",
      baselineCredits: -1,
      phase: "waiting",
    });
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
    clearMaxGrantWait();
    vi.clearAllMocks();
    mocks.osAccountsChangePlan.mockResolvedValue({ subscribed: true, plan: "max" });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.osAccountsUpgradeSession.mockResolvedValue(undefined);
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
