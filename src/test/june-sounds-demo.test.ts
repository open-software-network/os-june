import { afterEach, describe, expect, it, vi } from "vitest";

const soundMocks = vi.hoisted(() => ({
  playAgentSound: vi.fn(),
  playRecordingSound: vi.fn(),
}));

vi.mock("../lib/agent-sounds", () => ({ playAgentSound: soundMocks.playAgentSound }));
vi.mock("../lib/recording-sounds", () => ({
  playRecordingSound: soundMocks.playRecordingSound,
}));

import { registerJuneSoundsDemo } from "../lib/june-sounds-demo";

type SoundWindow = typeof window & {
  __juneSounds?: (command?: string) => string;
};

describe("June sound console demo", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    (window as SoundWindow).__juneSounds = undefined;
  });

  it("prints the sound-family menu when called without a command", () => {
    const api = registerJuneSoundsDemo();

    expect((window as SoundWindow).__juneSounds?.()).toContain('__juneSounds("all")');

    api.dispose();
    expect((window as SoundWindow).__juneSounds).toBeUndefined();
  });

  it("plays each family on demand", async () => {
    vi.useFakeTimers();
    registerJuneSoundsDemo();

    expect((window as SoundWindow).__juneSounds?.("recording")).toContain("recording");
    await vi.runAllTimersAsync();
    expect(soundMocks.playRecordingSound.mock.calls).toEqual([["start"], ["pause"], ["stop"]]);

    vi.clearAllMocks();
    expect((window as SoundWindow).__juneSounds?.("agent")).toContain("agent");
    await vi.runAllTimersAsync();
    expect(soundMocks.playAgentSound.mock.calls).toEqual([["ready"], ["needsInput"]]);
  });

  it("plays the complete family in recording-then-agent order", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    soundMocks.playRecordingSound.mockImplementation((sound) => order.push(sound));
    soundMocks.playAgentSound.mockImplementation((sound) => order.push(sound));
    registerJuneSoundsDemo();

    (window as SoundWindow).__juneSounds?.("all");
    await vi.runAllTimersAsync();

    expect(order).toEqual(["start", "pause", "stop", "ready", "needsInput"]);
  });

  it("cancels a running sequence when a single cue is requested", async () => {
    vi.useFakeTimers();
    registerJuneSoundsDemo();

    (window as SoundWindow).__juneSounds?.("all");
    (window as SoundWindow).__juneSounds?.("ready");
    await vi.runAllTimersAsync();

    expect(soundMocks.playRecordingSound.mock.calls).toEqual([["start"]]);
    expect(soundMocks.playAgentSound.mock.calls).toEqual([["ready"]]);
  });
});
