import { afterEach, describe, expect, it, vi } from "vitest";
import { playAgentSound, preloadAgentSounds } from "../lib/agent-sounds";

describe("agent sounds", () => {
  const originalAudio = globalThis.Audio;

  afterEach(() => {
    globalThis.Audio = originalAudio;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function installAudioMock(play = vi.fn().mockResolvedValue(undefined)) {
    const load = vi.fn();
    const playbackElements: Array<{
      addEventListener: ReturnType<typeof vi.fn>;
      currentTime: number;
      pause: ReturnType<typeof vi.fn>;
      paused: boolean;
      play: ReturnType<typeof vi.fn>;
      volume: number;
    }> = [];
    const audio = vi.fn().mockImplementation(() => ({
      cloneNode: vi.fn(() => {
        const playbackAudio = {
          addEventListener: vi.fn(),
          currentTime: 1,
          pause: vi.fn(() => {
            playbackAudio.paused = true;
          }),
          paused: false,
          play,
          volume: 1,
        };
        playbackElements.push(playbackAudio);
        return playbackAudio;
      }),
      load,
      preload: "",
      volume: 1,
    }));

    globalThis.Audio = audio as unknown as typeof Audio;
    return { audio, load, play, playbackElements };
  }

  it("plays the authored ready and needs-input cues", () => {
    vi.useFakeTimers();
    const { audio, play } = installAudioMock();

    expect(playAgentSound("ready")).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(playAgentSound("needsInput")).toBe(true);

    expect(audio).toHaveBeenNthCalledWith(1, "/sounds/agent-ready.mp3");
    expect(audio).toHaveBeenNthCalledWith(2, "/sounds/agent-needs-input.mp3");
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("preloads and reuses the bundled cues", () => {
    const { audio, load, play } = installAudioMock();

    preloadAgentSounds();
    playAgentSound("ready");

    expect(audio).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledOnce();
  });

  it("stops the active cue before playing the next one", () => {
    vi.useFakeTimers();
    const { playbackElements } = installAudioMock();

    playAgentSound("ready");
    vi.advanceTimersByTime(1_000);
    playAgentSound("needsInput");

    expect(playbackElements[0]?.pause).toHaveBeenCalledOnce();
    expect(playbackElements[1]?.pause).not.toHaveBeenCalled();
  });

  it("keeps agent completion resilient when playback is unavailable", () => {
    globalThis.Audio = undefined as unknown as typeof Audio;

    expect(playAgentSound("ready")).toBe(false);
  });

  it("coalesces a burst of agent cues", () => {
    vi.useFakeTimers();
    const { play } = installAudioMock();

    expect(playAgentSound("ready")).toBe(true);
    expect(playAgentSound("needsInput")).toBe(false);

    expect(play).toHaveBeenCalledOnce();
  });
});
