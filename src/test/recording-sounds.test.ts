import { afterEach, describe, expect, it, vi } from "vitest";
import { playRecordingSound } from "../lib/recording-sounds";

describe("playRecordingSound", () => {
  const originalAudio = globalThis.Audio;

  afterEach(() => {
    globalThis.Audio = originalAudio;
    vi.restoreAllMocks();
  });

  it("plays the bundled start and stop recording sounds", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const audio = vi.fn().mockImplementation(() => ({
      play,
      volume: 1,
    }));

    globalThis.Audio = audio as unknown as typeof Audio;

    playRecordingSound("start");
    playRecordingSound("stop");

    expect(audio).toHaveBeenNthCalledWith(1, "/sounds/record-start.mp3");
    expect(audio).toHaveBeenNthCalledWith(2, "/sounds/record-end.mp3");
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("ignores playback failures", () => {
    const play = vi.fn().mockRejectedValue(new Error("blocked"));

    globalThis.Audio = vi.fn().mockImplementation(() => ({
      play,
      volume: 1,
    })) as unknown as typeof Audio;

    expect(() => playRecordingSound("start")).not.toThrow();
  });
});
