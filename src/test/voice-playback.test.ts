import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  play: vi.fn(),
  settings: vi.fn(),
  status: vi.fn(),
  synthesize: vi.fn(),
  warm: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../lib/tauri", () => ({
  VOICE_PLAYBACK_STATUS_EVENT: "june://voice-playback-status",
  voicePlaybackCancel: mocks.cancel,
  voicePlaybackPlay: mocks.play,
  voicePlaybackSettings: mocks.settings,
  voicePlaybackStatus: mocks.status,
  voicePlaybackSynthesize: mocks.synthesize,
  voicePlaybackWarm: mocks.warm,
}));

import {
  applyVoicePlaybackSettings,
  finishStreamedVoiceTurn,
  initVoicePlayback,
  queueStreamedVoiceChunk,
  speakVoiceTurn,
  stopVoicePlayback,
  voicePlaybackState,
} from "../lib/voice-playback";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

async function nextTask() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  mocks.settings.mockResolvedValue({ playbackMode: "click", modelUseAcknowledged: true });
  mocks.status.mockResolvedValue({ state: "ready" });
  mocks.warm.mockResolvedValue(undefined);
  await initVoicePlayback();
});

beforeEach(() => {
  mocks.cancel.mockResolvedValue(undefined);
  mocks.play.mockResolvedValue(undefined);
  mocks.synthesize.mockImplementation((text: string) =>
    Promise.resolve({ wavPath: `/tmp/${text.length}.wav` }),
  );
});

afterEach(async () => {
  await stopVoicePlayback();
  vi.clearAllMocks();
});

describe("voice playback controller", () => {
  it("synthesizes before asking the native player to play", async () => {
    const synthesis = deferred<{ wavPath: string }>();
    mocks.synthesize.mockReturnValueOnce(synthesis.promise);

    await speakVoiceTurn("turn-1", "A spoken reply.");
    expect(mocks.synthesize).toHaveBeenCalledWith("A spoken reply.");
    expect(mocks.play).not.toHaveBeenCalled();

    synthesis.resolve({ wavPath: "/tmp/reply.wav" });
    await nextTask();
    expect(mocks.play).toHaveBeenCalledWith("/tmp/reply.wav");
  });

  it("waits for native cancellation before a replacement starts", async () => {
    const firstSynthesis = deferred<{ wavPath: string }>();
    const cancellation = deferred<void>();
    mocks.synthesize.mockReturnValueOnce(firstSynthesis.promise);
    mocks.cancel.mockReturnValueOnce(cancellation.promise);

    await speakVoiceTurn("turn-1", "First reply.");
    const replacement = speakVoiceTurn("turn-2", "Second reply.");
    await nextTask();
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);

    cancellation.resolve();
    await replacement;
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
    expect(mocks.synthesize).toHaveBeenLastCalledWith("Second reply.");
  });

  it("keeps cancellation failures visible and rejects the stop", async () => {
    await speakVoiceTurn("turn-1", "Reply.");
    mocks.cancel.mockRejectedValueOnce(new Error("Could not stop local audio"));

    await expect(stopVoicePlayback({ releaseModel: true })).rejects.toThrow(
      "Could not stop local audio",
    );
    expect(voicePlaybackState().error).toBe("Could not stop local audio");
  });

  it("surfaces synthesis failures in shared state", async () => {
    mocks.synthesize.mockRejectedValueOnce(new Error("Model generation failed"));

    await speakVoiceTurn("turn-1", "Reply.");
    await nextTask();
    expect(voicePlaybackState().turnId).toBeNull();
    expect(voicePlaybackState().error).toBe("Model generation failed");
  });

  it("keeps a stream active between sentences and releases it after the final drain", async () => {
    applyVoicePlaybackSettings({ playbackMode: "streaming", modelUseAcknowledged: true });
    const firstPlayback = deferred<void>();
    mocks.play.mockReturnValueOnce(firstPlayback.promise).mockResolvedValueOnce(undefined);

    await queueStreamedVoiceChunk("turn-stream", "First sentence.");
    await nextTask();
    expect(voicePlaybackState().turnId).toBe("turn-stream");

    await queueStreamedVoiceChunk("turn-stream", "Final sentence.");
    await finishStreamedVoiceTurn("turn-stream");
    firstPlayback.resolve();
    await nextTask();
    await nextTask();

    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(voicePlaybackState().turnId).toBeNull();
  });
});
