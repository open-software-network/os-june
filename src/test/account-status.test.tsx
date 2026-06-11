import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAccountStatus } from "../lib/account-status";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  osAccountsLogout: vi.fn(),
  osAccountsStatus: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsStatus: mocks.osAccountsStatus,
}));

function StatusProbe({
  forceLogoutOnMount = false,
}: {
  forceLogoutOnMount?: boolean;
}) {
  const account = useAccountStatus({ forceLogoutOnMount }).account;
  return <div>{account.signedIn ? "Signed in" : "Signed out"}</div>;
}

describe("useAccountStatus", () => {
  it("logs out before loading account status when forced on mount", async () => {
    const calls: string[] = [];
    const signedOut: AccountStatus = { signedIn: false, configured: true };
    mocks.osAccountsLogout.mockImplementation(async () => {
      calls.push("logout");
    });
    mocks.osAccountsStatus.mockImplementation(async () => {
      calls.push("status");
      return signedOut;
    });

    render(<StatusProbe forceLogoutOnMount />);

    await screen.findByText("Signed out");
    await waitFor(() => expect(calls).toEqual(["logout", "status"]));
  });
});
