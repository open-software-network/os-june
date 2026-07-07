import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getActiveHermesProfileName,
  refreshActiveHermesProfile,
  setActiveHermesProfileName,
  subscribe,
} from "../lib/active-hermes-profile";

const mocks = vi.hoisted(() => ({
  hermesBridgeStatus: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  invoke: mocks.invoke,
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
    setActiveHermesProfileName("default");
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: sandboxedConnection,
      connections: [sandboxedConnection],
    });
    mocks.invoke.mockResolvedValue({ active: "default", current: "default" });
  });

  it("defaults to the default profile", () => {
    expect(getActiveHermesProfileName()).toBe("default");
  });

  it("refreshes the active profile through the Hermes admin client", async () => {
    mocks.invoke.mockResolvedValue({ active: "research", current: "default" });

    await expect(refreshActiveHermesProfile()).resolves.toBe("research");

    expect(getActiveHermesProfileName()).toBe("research");
    expect(mocks.invoke).toHaveBeenCalledWith("hermes_admin_request", {
      mode: "sandboxed",
      method: "GET",
      path: "/api/profiles/active",
      body: undefined,
    });
  });

  it("falls back to default when refresh fails", async () => {
    setActiveHermesProfileName("research");
    mocks.invoke.mockRejectedValue(new Error("bridge unavailable"));

    await expect(refreshActiveHermesProfile()).resolves.toBe("default");

    expect(getActiveHermesProfileName()).toBe("default");
  });

  it("notifies subscribers when the cached profile changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    setActiveHermesProfileName("research");

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setActiveHermesProfileName("writing");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
