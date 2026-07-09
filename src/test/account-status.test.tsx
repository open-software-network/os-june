import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAccountStatus } from "../lib/account-status";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  osAccountsLogout: vi.fn(),
  osAccountsStatus: vi.fn(),
  osAccountsStatusLocal: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationCapabilities: vi.fn().mockResolvedValue({ capabilities: { available: true, platform: "macos", shortcuts: true, paste: true, microphoneSelection: true, accessibilityPermission: true, systemAudio: true } }),
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsStatus: mocks.osAccountsStatus,
  osAccountsStatusLocal: mocks.osAccountsStatusLocal,
}));

function StatusProbe({ forceLogoutOnMount = false }: { forceLogoutOnMount?: boolean }) {
  const { account, loading } = useAccountStatus({ forceLogoutOnMount });
  return (
    <div>
      <div>{account.signedIn ? "Signed in" : "Signed out"}</div>
      <div>{loading ? "Loading" : "Ready"}</div>
    </div>
  );
}

describe("useAccountStatus", () => {
  it("logs out before loading account status when forced on mount", async () => {
    const calls: string[] = [];
    const signedOut: AccountStatus = { signedIn: false, configured: true };
    mocks.osAccountsLogout.mockImplementation(async () => {
      calls.push("logout");
    });
    mocks.osAccountsStatusLocal.mockImplementation(async () => {
      calls.push("local");
      return signedOut;
    });
    mocks.osAccountsStatus.mockImplementation(async () => {
      calls.push("status");
      return signedOut;
    });

    render(<StatusProbe forceLogoutOnMount />);

    await screen.findByText("Signed out");
    expect(mocks.osAccountsLogout.mock.calls[0]?.[0]?.clearBrowserSession).not.toBe(true);
    await waitFor(() => expect(calls).toEqual(["logout", "local", "status"]));
  });

  it("clears loading after the local status even if the full status is slow", async () => {
    const signedInLocal: AccountStatus = { signedIn: true, configured: true };
    mocks.osAccountsLogout.mockResolvedValue(undefined);
    mocks.osAccountsStatusLocal.mockResolvedValue(signedInLocal);
    // Full snapshot never resolves during the test window.
    mocks.osAccountsStatus.mockImplementation(() => new Promise<AccountStatus>(() => {}));

    render(<StatusProbe />);

    await screen.findByText("Signed in");
    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
  });
});
