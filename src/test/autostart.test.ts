import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pluginMocks = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-autostart", () => pluginMocks);

import {
  applyAutostartDefaultOnce,
  autostartEnabled,
  setAutostartEnabled,
} from "../lib/autostart";

const DEFAULT_APPLIED_KEY = "june.autostart.defaultApplied";

function markTauri() {
  (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
}

function unmarkTauri() {
  delete (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
}

describe("autostart", () => {
  beforeEach(() => {
    markTauri();
    window.localStorage.clear();
    pluginMocks.isEnabled.mockResolvedValue(false);
    pluginMocks.enable.mockResolvedValue(undefined);
    pluginMocks.disable.mockResolvedValue(undefined);
  });

  afterEach(() => {
    unmarkTauri();
    vi.clearAllMocks();
  });

  it("reads the login item state from the plugin", async () => {
    pluginMocks.isEnabled.mockResolvedValue(true);
    await expect(autostartEnabled()).resolves.toBe(true);
  });

  it("reports disabled outside Tauri without touching the plugin", async () => {
    unmarkTauri();
    await expect(autostartEnabled()).resolves.toBe(false);
    expect(pluginMocks.isEnabled).not.toHaveBeenCalled();
  });

  it("routes enable and disable to the plugin", async () => {
    await setAutostartEnabled(true);
    expect(pluginMocks.enable).toHaveBeenCalledTimes(1);
    await setAutostartEnabled(false);
    expect(pluginMocks.disable).toHaveBeenCalledTimes(1);
  });

  it("applies the launch-at-login default exactly once", async () => {
    await applyAutostartDefaultOnce();
    expect(pluginMocks.enable).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(DEFAULT_APPLIED_KEY)).toBe("1");

    // Second completion (onboarding version bump): no re-enable, so a user
    // who turned the login item off is not opted back in.
    await applyAutostartDefaultOnce();
    expect(pluginMocks.enable).toHaveBeenCalledTimes(1);
  });

  it("retries the default on the next run after a failed enable", async () => {
    pluginMocks.enable.mockRejectedValueOnce(new Error("no launch agent dir"));
    await applyAutostartDefaultOnce();
    expect(window.localStorage.getItem(DEFAULT_APPLIED_KEY)).toBeNull();

    await applyAutostartDefaultOnce();
    expect(pluginMocks.enable).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(DEFAULT_APPLIED_KEY)).toBe("1");
  });

  it("does nothing outside Tauri", async () => {
    unmarkTauri();
    await applyAutostartDefaultOnce();
    expect(pluginMocks.enable).not.toHaveBeenCalled();
  });
});
