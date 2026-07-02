import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformCapabilities } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  getPlatformCapabilities: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  getPlatformCapabilities: mocks.getPlatformCapabilities,
}));

function stubNavigatorPlatform(platform: string, userAgent: string) {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => platform,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => userAgent,
  });
}

const windowsBuild: PlatformCapabilities = {
  systemAudio: true,
  meetingDetection: true,
  dictation: false,
};

// The module caches the backend answer for the lifetime of the app, so each
// test gets a fresh copy via resetModules + dynamic import.
async function loadModule() {
  vi.resetModules();
  return import("../lib/capabilities");
}

describe("platformCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the backend answer and caches it across calls", async () => {
    mocks.getPlatformCapabilities.mockResolvedValue(windowsBuild);
    const { platformCapabilities, cachedPlatformCapabilities } = await loadModule();

    expect(cachedPlatformCapabilities()).toBeUndefined();
    await expect(platformCapabilities()).resolves.toEqual(windowsBuild);
    await expect(platformCapabilities()).resolves.toEqual(windowsBuild);

    // Capabilities are static per build: one IPC read, then the cache.
    expect(mocks.getPlatformCapabilities).toHaveBeenCalledTimes(1);
    expect(cachedPlatformCapabilities()).toEqual(windowsBuild);
  });

  it("shares one in-flight IPC call between concurrent readers", async () => {
    mocks.getPlatformCapabilities.mockResolvedValue(windowsBuild);
    const { platformCapabilities } = await loadModule();

    const [first, second] = await Promise.all([platformCapabilities(), platformCapabilities()]);

    expect(first).toEqual(windowsBuild);
    expect(second).toEqual(windowsBuild);
    expect(mocks.getPlatformCapabilities).toHaveBeenCalledTimes(1);
  });

  it("falls back to the platform sniff on IPC failure without caching it", async () => {
    stubNavigatorPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    mocks.getPlatformCapabilities.mockRejectedValue(new Error("no backend"));
    const { platformCapabilities, cachedPlatformCapabilities } = await loadModule();

    await expect(platformCapabilities()).resolves.toEqual({
      systemAudio: true,
      meetingDetection: true,
      dictation: true,
    });
    // A failure is not cached, so the next read retries the backend.
    expect(cachedPlatformCapabilities()).toBeUndefined();

    mocks.getPlatformCapabilities.mockResolvedValue(windowsBuild);
    await expect(platformCapabilities()).resolves.toEqual(windowsBuild);
    expect(mocks.getPlatformCapabilities).toHaveBeenCalledTimes(2);
    expect(cachedPlatformCapabilities()).toEqual(windowsBuild);
  });

  it("sniffs a mac-shaped fallback on macOS", async () => {
    // setup.ts pins the navigator to macOS.
    const { fallbackPlatformCapabilities } = await loadModule();

    expect(fallbackPlatformCapabilities()).toEqual({
      systemAudio: true,
      meetingDetection: true,
      dictation: true,
    });
  });

  it("sniffs a linux-shaped fallback elsewhere", async () => {
    stubNavigatorPlatform("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
    const { fallbackPlatformCapabilities } = await loadModule();

    expect(fallbackPlatformCapabilities()).toEqual({
      systemAudio: true,
      meetingDetection: false,
      dictation: false,
    });
  });
});

describe("usePlatformCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts from the sniffed fallback and reconciles to the backend answer", async () => {
    // macOS-shaped navigator (from setup.ts) but a build that reports no
    // dictation: the hook must settle on the backend's verdict.
    mocks.getPlatformCapabilities.mockResolvedValue({
      systemAudio: true,
      meetingDetection: true,
      dictation: false,
    });
    const { usePlatformCapabilities } = await loadModule();

    const { result } = renderHook(() => usePlatformCapabilities());

    // First render: the sniffed fallback (mac implies dictation).
    expect(result.current.dictation).toBe(true);
    await waitFor(() => expect(result.current.dictation).toBe(false));
    expect(result.current.systemAudio).toBe(true);
  });

  it("keeps the fallback when the backend is unreachable", async () => {
    mocks.getPlatformCapabilities.mockRejectedValue(new Error("no backend"));
    const { usePlatformCapabilities, fallbackPlatformCapabilities } = await loadModule();

    const { result } = renderHook(() => usePlatformCapabilities());

    await waitFor(() => expect(mocks.getPlatformCapabilities).toHaveBeenCalled());
    expect(result.current).toEqual(fallbackPlatformCapabilities());
  });

  it("serves the cached backend answer synchronously on later mounts", async () => {
    mocks.getPlatformCapabilities.mockResolvedValue(windowsBuild);
    const { usePlatformCapabilities, platformCapabilities } = await loadModule();
    await platformCapabilities();

    const { result } = renderHook(() => usePlatformCapabilities());

    // No flash: the first render already carries the backend answer.
    expect(result.current).toEqual(windowsBuild);
    expect(mocks.getPlatformCapabilities).toHaveBeenCalledTimes(1);
  });
});
