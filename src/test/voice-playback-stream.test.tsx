import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JuneHermesEvent } from "../lib/hermes-control-plane";

const mocks = vi.hoisted(() => ({
  finish: vi.fn().mockResolvedValue(undefined),
  init: vi.fn().mockResolvedValue(undefined),
  queue: vi.fn().mockResolvedValue(undefined),
  rekey: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  streamingEnabled: vi.fn(() => true),
}));

vi.mock("../lib/voice-playback", () => ({
  finishStreamedVoiceTurn: mocks.finish,
  initVoicePlayback: mocks.init,
  queueStreamedVoiceChunk: mocks.queue,
  rekeyStreamedVoiceTurn: mocks.rekey,
  stopVoicePlayback: mocks.stop,
  streamingVoicePlaybackEnabled: mocks.streamingEnabled,
}));

import {
  acceptAgentVoicePlaybackEvent,
  useAgentVoicePlayback,
} from "../lib/use-agent-voice-playback";

function transcriptEvent(
  overrides: Partial<Extract<JuneHermesEvent, { kind: "transcript" }>>,
): Extract<JuneHermesEvent, { kind: "transcript" }> {
  return {
    kind: "transcript",
    sessionId: "session-1",
    failed: false,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function lifecycleEvent(
  overrides: Partial<Extract<JuneHermesEvent, { kind: "lifecycle" }>>,
): Extract<JuneHermesEvent, { kind: "lifecycle" }> {
  return {
    kind: "lifecycle",
    sessionId: "session-1",
    flavor: "info",
    status: "session.info",
    text: "",
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.streamingEnabled.mockReturnValue(true);
});

afterEach(() => {
  mocks.stop.mockClear();
});

describe("agent voice stream tracking", () => {
  it("rekeys the live turn and flushes its final tail under the persisted id", () => {
    const { unmount } = renderHook(() => useAgentVoicePlayback("session-1"));

    act(() => {
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ delta: "First sentence. Final tail", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({
          role: "assistant",
          messageId: "message-9",
          delta: "First sentence. Final tail",
          complete: true,
        }),
      );
    });

    expect(mocks.queue).toHaveBeenNthCalledWith(1, "voice-stream:session-1", "First sentence.");
    expect(mocks.rekey).toHaveBeenCalledWith("voice-stream:session-1", "message-9");
    expect(mocks.queue).toHaveBeenNthCalledWith(2, "message-9", "Final tail");
    expect(mocks.finish).toHaveBeenCalledWith("message-9");
    unmount();
  });

  it("accepts missing-role transcripts but ignores explicit user events", () => {
    renderHook(() => useAgentVoicePlayback("session-1"));

    act(() => {
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "user", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "user", delta: "User echo.", complete: false }),
      );
    });
    expect(mocks.queue).not.toHaveBeenCalled();

    act(() => {
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ delta: "Assistant variant. Tail", complete: false }),
      );
    });
    expect(mocks.queue).toHaveBeenCalledWith("voice-stream:session-1", "Assistant variant.");
  });

  it("ignores reasoning, tools, and background sessions", () => {
    renderHook(() => useAgentVoicePlayback("session-1"));

    act(() => {
      acceptAgentVoicePlaybackEvent("session-2", transcriptEvent({ role: "assistant" }));
      acceptAgentVoicePlaybackEvent("session-1", {
        kind: "reasoning",
        sessionId: "session-1",
        delta: "Private chain of thought.",
        receivedAt: new Date().toISOString(),
      });
      acceptAgentVoicePlaybackEvent("session-1", {
        kind: "tool",
        sessionId: "session-1",
        phase: "complete",
        key: "shell",
        text: "Tool output",
        isClarify: false,
        receivedAt: new Date().toISOString(),
      });
    });

    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("stops a failed reply and starts the next reply with a fresh tracker", () => {
    const { unmount } = renderHook(() => useAgentVoicePlayback("session-1"));

    act(() => {
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ delta: "Old sentence.", complete: false }),
      );
      acceptAgentVoicePlaybackEvent("session-1", {
        kind: "error",
        sessionId: "session-1",
        message: "The turn failed.",
        receivedAt: new Date().toISOString(),
      });
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", messageId: "message-new", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ delta: "Fresh reply. Tail", complete: false }),
      );
    });

    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.queue).toHaveBeenLastCalledWith("message-new", "Fresh reply.");
    expect(mocks.rekey).not.toHaveBeenCalled();
    unmount();
  });

  it("flushes a successful terminal lifecycle and ignores non-terminal lifecycle events", () => {
    const { unmount } = renderHook(() => useAgentVoicePlayback("session-1"));

    act(() => {
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", messageId: "message-old", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ delta: "Final tail", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        lifecycleEvent({ flavor: "running", status: "working" }),
      );
    });
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();

    act(() => {
      acceptAgentVoicePlaybackEvent(
        "session-1",
        lifecycleEvent({ flavor: "terminal", status: "completed" }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", messageId: "message-next", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ delta: "Next reply. Tail", complete: false }),
      );
    });

    expect(mocks.queue).toHaveBeenNthCalledWith(1, "message-old", "Final tail");
    expect(mocks.finish).toHaveBeenCalledWith("message-old");
    expect(mocks.queue).toHaveBeenNthCalledWith(2, "message-next", "Next reply.");
    expect(mocks.rekey).not.toHaveBeenCalled();
    unmount();
  });

  it("stops failed transcript completions and failed terminal lifecycle events", () => {
    const { unmount } = renderHook(() => useAgentVoicePlayback("session-1"));

    act(() => {
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ delta: "Partial reply.", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ delta: "The failed reply.", complete: true, failed: true }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        lifecycleEvent({ flavor: "terminal", status: "cancelled" }),
      );
    });

    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(mocks.finish).not.toHaveBeenCalled();
    unmount();
  });

  it("stops queued audio when an error follows a completed transcript", () => {
    const { unmount } = renderHook(() => useAgentVoicePlayback("session-1"));

    act(() => {
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", delta: "Finished reply.", complete: false }),
      );
      acceptAgentVoicePlaybackEvent(
        "session-1",
        transcriptEvent({ role: "assistant", delta: "Finished reply.", complete: true }),
      );
      acceptAgentVoicePlaybackEvent("session-1", {
        kind: "error",
        sessionId: "session-1",
        message: "The turn failed after transcript completion.",
        receivedAt: new Date().toISOString(),
      });
    });

    expect(mocks.finish).toHaveBeenCalledWith("voice-stream:session-1");
    expect(mocks.stop).toHaveBeenCalledOnce();
    unmount();
  });
});
