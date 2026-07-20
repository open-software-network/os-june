import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  getActiveHermesProfileName,
  isActiveHermesProfileConfirmed,
  refreshActiveHermesProfile,
  resetActiveHermesProfileForTests,
  setActiveHermesProfileName,
  subscribe,
  useActiveHermesProfile,
  useActiveHermesProfileName,
} from "../lib/active-hermes-profile";

const mocks = vi.hoisted(() => ({
  hermesBridgeStatus: vi.fn(),
  invoke: vi.fn(),
  stickyActiveProfile: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  invoke: mocks.invoke,
  stickyActiveProfile: mocks.stickyActiveProfile,
}));

const sandboxedConnection = {
  baseUrl: "http://127.0.0.1:61234",
  wsUrl: "ws://127.0.0.1:61234",
  token: "token",
  port: 61234,
  command: "hermes",
  hermesHome: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes",
  providerProxyPort: 61235,
  pid: 42,
  sandboxed: true,
  fullMode: false,
};

describe("active Hermes profile store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveHermesProfileForTests();
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: sandboxedConnection,
      connections: [sandboxedConnection],
    });
    mocks.invoke.mockResolvedValue({ active: "default", current: "default" });
    // Both resolution paths failing is the baseline for the "refresh fails"
    // cases; fallback tests override this with a resolved sticky value.
    mocks.stickyActiveProfile.mockRejectedValue(new Error("no tauri shell"));
  });

  it("defaults to the default profile", () => {
    expect(getActiveHermesProfileName()).toBe("default");
    expect(isActiveHermesProfileConfirmed()).toBe(false);
  });

  it("refreshes the active profile through the Hermes admin client", async () => {
    mocks.invoke.mockResolvedValue({ active: "research", current: "default" });

    await expect(refreshActiveHermesProfile()).resolves.toBe("research");

    expect(getActiveHermesProfileName()).toBe("research");
    expect(isActiveHermesProfileConfirmed()).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("hermes_admin_request", {
      mode: "sandboxed",
      method: "GET",
      path: "/api/profiles/active",
      body: undefined,
    });
  });

  it("keeps a confirmed profile when a later refresh fails", async () => {
    setActiveHermesProfileName("research");
    mocks.invoke.mockRejectedValue(new Error("bridge unavailable"));

    await expect(refreshActiveHermesProfile()).resolves.toBe("research");

    expect(getActiveHermesProfileName()).toBe("research");
  });

  it("stays on default when a refresh fails before anything was confirmed", async () => {
    mocks.invoke.mockRejectedValue(new Error("bridge unavailable"));

    await expect(refreshActiveHermesProfile()).resolves.toBe("default");

    expect(getActiveHermesProfileName()).toBe("default");
    expect(isActiveHermesProfileConfirmed()).toBe(false);
  });

  it("falls back to the sticky file when the bridge is not running (cold start)", async () => {
    mocks.hermesBridgeStatus.mockResolvedValue({ running: false });
    mocks.stickyActiveProfile.mockResolvedValue("research");

    await expect(refreshActiveHermesProfile()).resolves.toBe("research");

    expect(getActiveHermesProfileName()).toBe("research");
    expect(isActiveHermesProfileConfirmed()).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("falls back to the sticky file when the admin request fails", async () => {
    mocks.invoke.mockRejectedValue(new Error("bridge unavailable"));
    mocks.stickyActiveProfile.mockResolvedValue("writing");

    await expect(refreshActiveHermesProfile()).resolves.toBe("writing");

    expect(getActiveHermesProfileName()).toBe("writing");
    expect(isActiveHermesProfileConfirmed()).toBe(true);
  });

  it("confirms and notifies when setting the same default name", () => {
    const listener = vi.fn();
    setActiveHermesProfileName("default");
    expect(isActiveHermesProfileConfirmed()).toBe(true);

    resetActiveHermesProfileForTests();
    const unsubscribe = subscribe(listener);
    setActiveHermesProfileName("default");

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("notifies subscribers when the cached profile changes", () => {
    setActiveHermesProfileName("default");
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    setActiveHermesProfileName("research");

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setActiveHermesProfileName("writing");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("exposes a React hook over the shared active profile subscription", () => {
    const { result } = renderHook(() => useActiveHermesProfile());

    expect(result.current).toEqual({ name: "default", confirmed: false });

    act(() => {
      setActiveHermesProfileName("research");
    });

    expect(result.current).toEqual({ name: "research", confirmed: true });
  });

  it("keeps the name-only hook working", () => {
    const { result } = renderHook(() => useActiveHermesProfileName());

    expect(result.current).toBe("default");

    act(() => {
      setActiveHermesProfileName("research");
    });

    expect(result.current).toBe("research");
  });

  it("hydrates from the sticky active profile on first hook mount", async () => {
    mocks.invoke.mockResolvedValue({ active: "research", current: "default" });

    const { result } = renderHook(() => useActiveHermesProfileName());

    await waitFor(() => expect(result.current).toBe("research"));
    expect(mocks.invoke).toHaveBeenCalledWith("hermes_admin_request", {
      mode: "sandboxed",
      method: "GET",
      path: "/api/profiles/active",
      body: undefined,
    });
  });

  it("retries hydration on a later subscribe while unconfirmed", async () => {
    mocks.invoke
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValueOnce({ active: "research", current: "default" });

    const first = renderHook(() => useActiveHermesProfile());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    expect(first.result.current).toEqual({ name: "default", confirmed: false });
    first.unmount();

    const second = renderHook(() => useActiveHermesProfile());

    await waitFor(() =>
      expect(second.result.current).toEqual({ name: "research", confirmed: true }),
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not hydrate on subscribe after the active profile is confirmed", async () => {
    setActiveHermesProfileName("research");

    renderHook(() => useActiveHermesProfile());

    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("coalesces subscribe-triggered refreshes while one is in flight", async () => {
    let resolveActive: (value: { active: string; current: string }) => void = () => {};
    mocks.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveActive = resolve;
        }),
    );

    const first = renderHook(() => useActiveHermesProfile());
    const second = renderHook(() => useActiveHermesProfile());

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));

    act(() => {
      resolveActive({ active: "research", current: "default" });
    });

    await waitFor(() => expect(first.result.current.confirmed).toBe(true));
    expect(second.result.current).toEqual({ name: "research", confirmed: true });
  });
});
