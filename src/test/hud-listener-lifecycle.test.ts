import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TauriListener = (event: { payload: unknown }) => unknown;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  unlistenHandles: [] as ReturnType<typeof vi.fn>[],
  listen: vi.fn((_event: string, _listener: TauriListener) => {
    const unlisten = vi.fn();
    mocks.unlistenHandles.push(unlisten);
    return Promise.resolve(unlisten);
  }),
  hide: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: mocks.hide,
    startDragging: mocks.startDragging,
  }),
}));

describe("HUD listener lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.unlistenHandles.length = 0;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    document.body.innerHTML = `
      <main id="agent-hud"></main>
      <main id="hud"></main>
      <main id="mhud"></main>
    `;
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("releases every Tauri listener on beforeunload", async () => {
    await import("../agent-hud");
    await import("../hud");
    await import("../meeting-hud");
    await vi.waitFor(() => {
      expect(mocks.unlistenHandles).toHaveLength(15);
    });

    window.dispatchEvent(new Event("beforeunload"));

    await vi.waitFor(() => {
      for (const unlisten of mocks.unlistenHandles) {
        expect(unlisten).toHaveBeenCalledOnce();
      }
    });
  });

  it("releases a Tauri listener that resolves after beforeunload", async () => {
    const { createHudLifecycle } = await import("../lib/hud-lifecycle");
    const lifecycle = createHudLifecycle();
    const unlisten = vi.fn();
    let resolveUnlisten: ((handle: () => void) => void) | undefined;

    lifecycle.trackUnlisten(
      new Promise((resolve) => {
        resolveUnlisten = resolve;
      }),
    );
    window.dispatchEvent(new Event("beforeunload"));
    resolveUnlisten?.(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledOnce();
  });
});
