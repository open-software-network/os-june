import { afterEach, describe, expect, it, vi } from "vitest";

const soundMocks = vi.hoisted(() => ({
  playAgentSound: vi.fn(),
  playRecordingSound: vi.fn(),
}));

vi.mock("../lib/agent-sounds", () => ({ playAgentSound: soundMocks.playAgentSound }));
vi.mock("../lib/recording-sounds", () => ({
  playRecordingSound: soundMocks.playRecordingSound,
}));

import { registerClovySoundsDemo } from "../lib/clovy-sounds-demo";

type SoundWindow = typeof window & {
  __clovySounds?: (command?: string) => string;
};

describe("Clovy sound console demo", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    (window as SoundWindow).__clovySounds = undefined;
  });

  it("prints the sound-family menu when called without a command", () => {
    const api = registerClovySoundsDemo();

    expect((window as SoundWindow).__clovySounds?.()).toContain('__clovySounds("all")');

    api.dispose();
    expect((window as SoundWindow).__clovySounds).toBeUndefined();
  });

  it("plays each family on demand", async () => {
    vi.useFakeTimers();
    registerClovySoundsDemo();

    expect((window as SoundWindow).__clovySounds?.("recording")).toContain("recording");
    await vi.runAllTimersAsync();
    expect(soundMocks.playRecordingSound.mock.calls).toEqual([["start"], ["pause"], ["stop"]]);

    vi.clearAllMocks();
    expect((window as SoundWindow).__clovySounds?.("agent")).toContain("agent");
    await vi.runAllTimersAsync();
    expect(soundMocks.playAgentSound.mock.calls).toEqual([["ready"], ["needsInput"]]);
  });

  it("plays the complete family in recording-then-agent order", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    soundMocks.playRecordingSound.mockImplementation((sound) => order.push(sound));
    soundMocks.playAgentSound.mockImplementation((sound) => order.push(sound));
    registerClovySoundsDemo();

    (window as SoundWindow).__clovySounds?.("all");
    await vi.runAllTimersAsync();

    expect(order).toEqual(["start", "pause", "stop", "ready", "needsInput"]);
  });

  it("cancels a running sequence when a single cue is requested", async () => {
    vi.useFakeTimers();
    registerClovySoundsDemo();

    (window as SoundWindow).__clovySounds?.("all");
    (window as SoundWindow).__clovySounds?.("ready");
    await vi.runAllTimersAsync();

    expect(soundMocks.playRecordingSound.mock.calls).toEqual([["start"]]);
    expect(soundMocks.playAgentSound.mock.calls).toEqual([["ready"]]);
  });
});
