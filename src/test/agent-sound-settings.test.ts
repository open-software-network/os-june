import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SOUNDS_CHANGED_EVENT,
  AGENT_SOUNDS_ENABLED_KEY,
  getAgentSoundsEnabled,
  setAgentSoundsEnabled,
  type AgentSoundsChangedDetail,
} from "../lib/agent-sound-settings";

describe("agent sound settings", () => {
  afterEach(() => {
    localStorage.removeItem(AGENT_SOUNDS_ENABLED_KEY);
  });

  it("defaults to on and persists an opt-out", () => {
    expect(getAgentSoundsEnabled()).toBe(true);

    setAgentSoundsEnabled(false);

    expect(getAgentSoundsEnabled()).toBe(false);
    expect(localStorage.getItem(AGENT_SOUNDS_ENABLED_KEY)).toBe("false");
  });

  it("announces preference changes in this window", () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(AGENT_SOUNDS_CHANGED_EVENT, listener);

    setAgentSoundsEnabled(true);

    expect((listener.mock.calls[0]?.[0] as CustomEvent<AgentSoundsChangedDetail>).detail).toEqual({
      enabled: true,
    });
    window.removeEventListener(AGENT_SOUNDS_CHANGED_EVENT, listener);
  });
});
