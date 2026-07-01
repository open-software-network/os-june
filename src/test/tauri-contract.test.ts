import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRecordingSourceReadiness,
  ensureHermesBridgeGateway,
  finishRecording,
  getNote,
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

  it("sends recording lifecycle commands with stable request shapes", async () => {
    await checkRecordingSourceReadiness("microphonePlusSystem");
    await startRecording("note-1", "microphonePlusSystem");
    await finishRecording("session-1");

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "check_recording_source_readiness",
      {
        request: { sourceMode: "microphonePlusSystem" },
      },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "start_recording", {
      request: { noteId: "note-1", sourceMode: "microphonePlusSystem" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "finish_recording", {
      request: { sessionId: "session-1" },
    });
  });

  it("keeps retry and recovery commands authoritative", async () => {
    await retryProcessing("note-1");
    await recoverRecording("session-1", "validate");
    await recoverRecording("session-2", "discard");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "retry_processing", {
      request: { noteId: "note-1", step: "all" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "recover_recording", {
      request: { sessionId: "session-1", action: "validate" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "recover_recording", {
      request: { sessionId: "session-2", action: "discard" },
    });
  });

  it("invokes the Hermes gateway ensure command for routines", async () => {
    await ensureHermesBridgeGateway();

    expect(mocks.invoke).toHaveBeenCalledWith("ensure_hermes_bridge_gateway");
  });

  it("opens the June community through a dedicated command", async () => {
    await juneOpenCommunityPage();

    expect(mocks.invoke).toHaveBeenCalledWith("june_open_community_page");
  });
});
