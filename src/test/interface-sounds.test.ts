import { afterEach, describe, expect, it, vi } from "vitest";
import { playAgentSound } from "../lib/agent-sounds";
import { playRecordingSound } from "../lib/recording-sounds";

describe("interface sound coordination", () => {
  const originalAudio = globalThis.Audio;

  afterEach(() => {
    globalThis.Audio = originalAudio;
    vi.useRealTimers();
  });

  function installAudioMock() {
    const playbackElements: Array<{
      listeners: Map<string, () => void>;
      currentTime: number;
      pause: ReturnType<typeof vi.fn>;
      paused: boolean;
      play: ReturnType<typeof vi.fn>;
    }> = [];
    globalThis.Audio = vi.fn().mockImplementation(() => ({
      cloneNode: vi.fn(() => {
        const playback = {
          listeners: new Map<string, () => void>(),
          currentTime: 0,
          pause: vi.fn(() => {
            playback.paused = true;
          }),
          paused: false,
          play: vi.fn().mockResolvedValue(undefined),
          volume: 1,
          addEventListener: vi.fn((event: string, listener: () => void) => {
            playback.listeners.set(event, listener);
          }),
        };
        playbackElements.push(playback);
        return playback;
      }),
      load: vi.fn(),
      preload: "",
      volume: 1,
    })) as unknown as typeof Audio;
    return playbackElements;
  }

  it("does not let an agent cue interrupt a recording cue", () => {
    vi.useFakeTimers();
    const playback = installAudioMock();

    playRecordingSound("stop");
    vi.advanceTimersByTime(2_000);

    expect(playAgentSound("ready")).toBe(false);
    expect(playback).toHaveLength(1);
    expect(playback[0]?.pause).not.toHaveBeenCalled();
  });

  it("lets a recording cue interrupt an agent cue", () => {
    vi.useFakeTimers();
    const playback = installAudioMock();

    expect(playAgentSound("ready")).toBe(true);
    playRecordingSound("start");

    expect(playback).toHaveLength(2);
    expect(playback[0]?.pause).toHaveBeenCalledOnce();
    expect(playback[1]?.pause).not.toHaveBeenCalled();
  });
});
