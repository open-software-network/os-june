import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CreditBalanceBanner,
  METERED_USAGE_CREDIT_FLOOR,
  accountCreditBalance,
  shouldShowLowCreditBanner,
} from "../components/account/CreditBalanceBanner";
import type { AccountStatus } from "../lib/tauri";

function activeAccount(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    signedIn: true,
    configured: true,
    user: { id: "usr_1", handle: "junho" },
    balance: {
      credits: METERED_USAGE_CREDIT_FLOOR - 1,
      usdMillis: METERED_USAGE_CREDIT_FLOOR - 1,
    },
    subscription: { subscribed: true, status: "active" },
    ...overrides,
  };
}

describe("shouldShowLowCreditBanner", () => {
  it("shows for active members below the metered usage floor", () => {
    expect(shouldShowLowCreditBanner(activeAccount())).toBe(true);
  });

  it("does not show at or above the metered usage floor", () => {
    expect(
      shouldShowLowCreditBanner(
        activeAccount({
          balance: {
            credits: METERED_USAGE_CREDIT_FLOOR,
            usdMillis: METERED_USAGE_CREDIT_FLOOR,
          },
        }),
      ),
    ).toBe(false);

    expect(
      shouldShowLowCreditBanner(
        activeAccount({
          balance: {
            credits: METERED_USAGE_CREDIT_FLOOR + 1,
            usdMillis: METERED_USAGE_CREDIT_FLOOR + 1,
          },
        }),
      ),
    ).toBe(false);
  });

  it("falls back to usdMillis when older payloads omit credits", () => {
    const account = activeAccount({
      balance: { usdMillis: METERED_USAGE_CREDIT_FLOOR - 1 },
    });

    expect(accountCreditBalance(account)).toBe(METERED_USAGE_CREDIT_FLOOR - 1);
    expect(shouldShowLowCreditBanner(account)).toBe(true);
  });

  it("prefers credits when both balance fields are present", () => {
    expect(
      shouldShowLowCreditBanner(
        activeAccount({
          balance: {
            credits: METERED_USAGE_CREDIT_FLOOR,
            usdMillis: METERED_USAGE_CREDIT_FLOOR - 1,
          },
        }),
      ),
    ).toBe(false);
  });

  it("stays hidden for users outside the active app membership path", () => {
    expect(
      shouldShowLowCreditBanner({ signedIn: false, configured: true }),
    ).toBe(false);
    expect(
      shouldShowLowCreditBanner(
        activeAccount({
          subscription: { subscribed: false },
        }),
      ),
    ).toBe(false);
    expect(
      shouldShowLowCreditBanner(
        activeAccount({
          subscription: { subscribed: true, status: "past_due" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldShowLowCreditBanner(
        activeAccount({
          balance: undefined,
        }),
      ),
    ).toBe(false);
  });
});

describe("CreditBalanceBanner", () => {
  it("notifies low-balance users and opens top-up", async () => {
    const onTopUp = vi.fn();
    render(<CreditBalanceBanner account={activeAccount()} onTopUp={onTopUp} />);

    expect(
      screen.getByRole("alert", { name: "Low credit balance" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Low balance")).toBeInTheDocument();
    expect(
      screen.getByText(/below the amount needed to start dictation/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add funds" }));
    expect(onTopUp).toHaveBeenCalledOnce();
  });

  it("renders nothing when the account has enough credits", () => {
    const { container } = render(
      <CreditBalanceBanner
        account={activeAccount({
          balance: {
            credits: METERED_USAGE_CREDIT_FLOOR,
            usdMillis: METERED_USAGE_CREDIT_FLOOR,
          },
        })}
        onTopUp={() => undefined}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
