import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRecordingSourceReadiness,
  downloadNoteAudio,
  ensureHermesBridgeGateway,
  finishRecording,
  getNote,
  juneHomeChat,
  juneOpenCommunityPage,
  recoverRecording,
  retryProcessing,
  startRecording,
  updateNote,
} from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => undefined;
  },
  invoke: mocks.invoke,
}));

describe("Tauri command contracts", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({});
  });

  it("wraps note retrieval and updates in request payloads", async () => {
    await getNote("note-1");
    await updateNote({
      noteId: "note-1",
      title: "Updated",
      editedContent: "Manual notes",
      activeTab: "transcription",
    });

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "get_note", {
      request: { noteId: "note-1" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "update_note", {
      request: {
        noteId: "note-1",
        title: "Updated",
        editedContent: "Manual notes",
        activeTab: "transcription",
      },
    });
  });

  it("downloads note audio through a note-scoped request", async () => {
    const response = {
      path: "/tmp/First note audio.wav",
      fileName: "First note audio.wav",
      sourceCount: 1,
    };
    mocks.invoke.mockResolvedValue(response);

    await expect(downloadNoteAudio("note-1")).resolves.toEqual(response);
    expect(mocks.invoke).toHaveBeenCalledWith("download_note_audio", {
      request: { noteId: "note-1" },
    });
  });

  it("sends recording lifecycle commands with stable request shapes", async () => {
    await checkRecordingSourceReadiness("microphonePlusSystem");
    await startRecording("note-1", "microphonePlusSystem");
    await finishRecording("session-1");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "check_recording_source_readiness", {
      request: { sourceMode: "microphonePlusSystem" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "start_recording", {
      request: { noteId: "note-1", sourceMode: "microphonePlusSystem" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "finish_recording", {
      request: { sessionId: "session-1" },
    });
  });

  it("keeps retry and recovery commands authoritative", async () => {
    await retryProcessing("note-1");
    await retryProcessing("note-1", "recording-2");
    await recoverRecording("session-1", "validate");
    await recoverRecording("session-2", "discard");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "retry_processing", {
      request: { noteId: "note-1", step: "all" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "retry_processing", {
      request: {
        noteId: "note-1",
        step: "all",
        recordingSessionId: "recording-2",
      },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "recover_recording", {
      request: { sessionId: "session-1", action: "validate" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "recover_recording", {
      request: { sessionId: "session-2", action: "discard" },
    });
  });

  it("invokes the Hermes gateway ensure command for routines", async () => {
    await ensureHermesBridgeGateway();

    expect(mocks.invoke).toHaveBeenCalledWith("ensure_hermes_bridge_gateway");
  });

  it("forwards Home channel deltas before resolving the final response", async () => {
    const deltas: string[] = [];
    mocks.invoke.mockImplementationOnce(async (command, args) => {
      expect(command).toBe("june_home_chat");
      const channel = (args as { onEvent: { onmessage: (event: unknown) => void } }).onEvent;
      channel.onmessage({ event: "delta", data: { content: "Hello" } });
      channel.onmessage({ event: "delta", data: { content: " there" } });
      return { content: "Hello there" };
    });

    await expect(
      juneHomeChat([{ role: "user", content: "Hi" }], {
        profile: "work",
        historyContext: "User: We call this Project Nebula.",
        model: "example-model",
        reasoningEffort: "none",
        onDelta: (content) => deltas.push(content),
      }),
    ).resolves.toEqual({ content: "Hello there" });

    expect(deltas).toEqual(["Hello", " there"]);
    expect(mocks.invoke).toHaveBeenCalledWith("june_home_chat", {
      request: {
        profile: "work",
        historyContext: "User: We call this Project Nebula.",
        model: "example-model",
        reasoningEffort: "none",
        messages: [{ role: "user", content: "Hi" }],
      },
      onEvent: expect.anything(),
    });
  });

  it("opens the June community through a dedicated command", async () => {
    await juneOpenCommunityPage();

    expect(mocks.invoke).toHaveBeenCalledWith("june_open_community_page");
  });
});
