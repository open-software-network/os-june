import { afterEach, describe, expect, it, vi } from "vitest";
import {
  playRecordingSound,
  preloadRecordingSounds,
} from "../lib/recording-sounds";

describe("playRecordingSound", () => {
  const originalAudio = globalThis.Audio;

  afterEach(() => {
    globalThis.Audio = originalAudio;
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

  it("plays the bundled recording sounds", () => {
    const { audio, play } = installAudioMock();

    playRecordingSound("start");
    playRecordingSound("pause");
    playRecordingSound("stop");

    expect(audio).toHaveBeenNthCalledWith(1, "/sounds/record-start.mp3");
    expect(audio).toHaveBeenNthCalledWith(2, "/sounds/record-pause.mp3");
    expect(audio).toHaveBeenNthCalledWith(3, "/sounds/record-end.mp3");
    expect(play).toHaveBeenCalledTimes(3);
  });

  it("preloads and reuses bundled recording sounds", () => {
    const { audio, load, play } = installAudioMock();

    preloadRecordingSounds();
    playRecordingSound("start");

    expect(audio).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenCalledTimes(3);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stops an active cue before playing the next one", () => {
    const { play, playbackElements } = installAudioMock();

    playRecordingSound("pause");
    playRecordingSound("start");

    expect(play).toHaveBeenCalledTimes(2);
    expect(playbackElements[0]?.pause).toHaveBeenCalledTimes(1);
    expect(playbackElements[1]?.pause).not.toHaveBeenCalled();
  });

  it("ignores playback failures", () => {
    const play = vi.fn().mockRejectedValue(new Error("blocked"));

    installAudioMock(play);

    expect(() => playRecordingSound("start")).not.toThrow();
  });
});
