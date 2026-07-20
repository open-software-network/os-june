import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_STATUS_TIMEOUT_MS,
  LOCAL_ACCOUNT_STATUS_TIMEOUT_MS,
  useAccountStatus,
} from "../lib/account-status";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  osAccountsLogout: vi.fn(),
  osAccountsStatus: vi.fn(),
  osAccountsStatusLocal: vi.fn(),
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
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsStatus: mocks.osAccountsStatus,
  osAccountsStatusLocal: mocks.osAccountsStatusLocal,
}));

function StatusProbe({ forceLogoutOnMount = false }: { forceLogoutOnMount?: boolean }) {
  const { account, error, loading } = useAccountStatus({ forceLogoutOnMount });
  return (
    <div>
      <div>{account.signedIn ? "Signed in" : "Signed out"}</div>
      <div>{loading ? "Loading" : "Ready"}</div>
      {error ? <div>{error}</div> : null}
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

  it("falls through to the full status when the local keychain lookup stalls", async () => {
    vi.useFakeTimers();
    const signedIn: AccountStatus = { signedIn: true, configured: true };
    mocks.osAccountsStatusLocal.mockImplementation(() => new Promise<AccountStatus>(() => {}));
    mocks.osAccountsStatus.mockResolvedValue(signedIn);

    render(<StatusProbe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_ACCOUNT_STATUS_TIMEOUT_MS);
    });

    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("leaves the loading gate with a retryable error when account lookups stall", async () => {
    vi.useFakeTimers();
    mocks.osAccountsStatusLocal.mockImplementation(() => new Promise<AccountStatus>(() => {}));
    mocks.osAccountsStatus.mockImplementation(() => new Promise<AccountStatus>(() => {}));

    render(<StatusProbe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_ACCOUNT_STATUS_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_TIMEOUT_MS);
    });

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Account status took too long. Please try again.")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
