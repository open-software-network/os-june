import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPERIMENTAL_UNLOCK_WINDOW_MS,
  INITIAL_EXPERIMENTAL_UNLOCK_CLICK_STATE,
  initializeExperimentalFlags,
  registerExperimentalUnlockClick,
  setExperimentalFlags,
} from "../lib/experimental-flags";
import { BROWSER_ACCESS_REQUEST_TOKEN, hasBrowserAccessRequest } from "../lib/browser-access";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../lib/feature-flags", () => ({
  BROWSER_USE_ENABLED: false,
}));

describe("experimental flags", () => {
  beforeEach(async () => {
    mocks.invoke.mockImplementation(async (command: string, input?: unknown) => {
      if (command === "experimental_flags_set") {
        return (input as { request: { unlocked: boolean; browser_use: boolean } }).request;
      }
      return { unlocked: false, browser_use: false };
    });
    mocks.listen.mockResolvedValue(() => {});
    await setExperimentalFlags({ unlocked: false, browser_use: false });
  });

  it("unlocks on the seventh click inside the time window", () => {
    let state = INITIAL_EXPERIMENTAL_UNLOCK_CLICK_STATE;
    let unlocked = false;

    for (let index = 0; index < 7; index += 1) {
      const result = registerExperimentalUnlockClick(state, 1_000 + index * 400);
      state = result.state;
      unlocked = result.unlocked;
    }

    expect(unlocked).toBe(true);
    expect(state).toEqual(INITIAL_EXPERIMENTAL_UNLOCK_CLICK_STATE);
  });

  it("starts a new unlock sequence after the time window", () => {
    const first = registerExperimentalUnlockClick(INITIAL_EXPERIMENTAL_UNLOCK_CLICK_STATE, 1_000);
    const late = registerExperimentalUnlockClick(
      first.state,
      1_000 + EXPERIMENTAL_UNLOCK_WINDOW_MS + 1,
    );

    expect(late).toEqual({
      state: { count: 1, startedAt: 1_000 + EXPERIMENTAL_UNLOCK_WINDOW_MS + 1 },
      unlocked: false,
    });
  });

  it("renders Browser access requests when the cached override is enabled", async () => {
    expect(hasBrowserAccessRequest(BROWSER_ACCESS_REQUEST_TOKEN)).toBe(false);

    await setExperimentalFlags({ unlocked: true, browser_use: true });

    expect(hasBrowserAccessRequest(BROWSER_ACCESS_REQUEST_TOKEN)).toBe(true);
  });

  it("disposes the previous event listener when flags are reinitialized", async () => {
    const firstUnlisten = vi.fn();
    mocks.listen.mockResolvedValueOnce(firstUnlisten).mockResolvedValueOnce(vi.fn());

    await initializeExperimentalFlags();
    await initializeExperimentalFlags();

    expect(firstUnlisten).toHaveBeenCalledOnce();
  });
});
