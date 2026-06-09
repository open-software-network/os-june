import { describe, expect, it } from "vitest";
import { createInitialState, notesReducer } from "../app/state/app-state";
import type {
  BootstrapResponse,
  NoteDto,
  RecordingStatusDto,
} from "../lib/tauri";

const now = "2026-05-19T10:00:00Z";

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "note-1",
    title: "",
    preview: "",
    processingStatus: "draft",
    folderIds: [],
    createdAt: now,
    updatedAt: now,
    activeTab: "notes",
    ...overrides,
  };
}

describe("notesReducer", () => {
  it("loads bootstrap data and selects the first note", () => {
    const payload: BootstrapResponse = {
      folders: [
        { id: "folder-1", name: "Ideas", createdAt: now, updatedAt: now },
      ],
      notes: [
        note({ id: "note-2", title: "Second" }),
        note({ id: "note-1", title: "First" }),
      ],
      activeRecoveries: [],
      providerConfigured: true,
    };

    const state = notesReducer(createInitialState(), {
      type: "bootstrapLoaded",
      payload,
    });

    expect(state.folders).toHaveLength(1);
    expect(state.notes.map((item) => item.id)).toEqual(["note-2", "note-1"]);
    expect(state.selectedNoteId).toBe("note-2");
    expect(state.providerConfigured).toBe(true);
  });

  it("updates the selected note after autosave", () => {
    const initial = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({ id: "note-1", title: "Draft" }),
    });

    const state = notesReducer(initial, {
      type: "noteUpdated",
      note: note({
        id: "note-1",
        title: "Edited",
        editedContent: "Clean notes",
      }),
    });

    expect(state.notes[0].title).toBe("Edited");
    expect(state.selectedNote?.editedContent).toBe("Clean notes");
  });

  it("keeps optimistic transcribing status when a stale validating note arrives", () => {
    const initial = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({
        id: "note-1",
        processingStatus: "transcribing",
      }),
    });

    const state = notesReducer(initial, {
      type: "noteUpdated",
      note: note({
        id: "note-1",
        title: "Server title",
        processingStatus: "validating",
      }),
    });

    expect(state.selectedNote?.title).toBe("Server title");
    expect(state.selectedNote?.processingStatus).toBe("transcribing");
    expect(state.notes[0].processingStatus).toBe("transcribing");
  });

  it("does not move generating backward when polling responses finish out of order", () => {
    const initial = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({
        id: "note-1",
        processingStatus: "generating",
      }),
    });

    const state = notesReducer(initial, {
      type: "noteUpdated",
      note: note({
        id: "note-1",
        processingStatus: "transcribing",
      }),
    });

    expect(state.selectedNote?.processingStatus).toBe("generating");
    expect(state.notes[0].processingStatus).toBe("generating");
  });

  it("accepts terminal processing statuses after optimistic transcribing", () => {
    const initial = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({
        id: "note-1",
        processingStatus: "transcribing",
      }),
    });

    const state = notesReducer(initial, {
      type: "noteUpdated",
      note: note({
        id: "note-1",
        processingStatus: "failed",
        lastError: "Transcription failed",
      }),
    });

    expect(state.selectedNote?.processingStatus).toBe("failed");
    expect(state.selectedNote?.lastError).toBe("Transcription failed");
  });

  it("lets an authoritative command restart processing on a failed note", () => {
    // Retry returns the note in an active status; without the bypass the
    // terminal guard would swallow it and the failure banner would never
    // clear even though the backend is reprocessing.
    const initial = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({
        id: "note-1",
        processingStatus: "failed",
        lastError: "Transcription failed",
      }),
    });

    const state = notesReducer(initial, {
      type: "noteProcessingUpdated",
      note: note({
        id: "note-1",
        processingStatus: "transcribing",
      }),
    });

    expect(state.selectedNote?.processingStatus).toBe("transcribing");
    expect(state.notes[0].processingStatus).toBe("transcribing");
  });

  it("lets a new take restart processing on a ready note", () => {
    // Stacking another recording on an already-ready note: the finish flow
    // marks it transcribing again so the shimmer shows and polling resumes.
    const initial = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({
        id: "note-1",
        processingStatus: "ready",
        generatedContent: "Finished notes",
      }),
    });

    const state = notesReducer(initial, {
      type: "noteProcessingUpdated",
      note: note({
        id: "note-1",
        processingStatus: "transcribing",
        generatedContent: "Finished notes",
      }),
    });

    expect(state.selectedNote?.processingStatus).toBe("transcribing");
    expect(state.notes[0].processingStatus).toBe("transcribing");
  });

  it("does not move a terminal note backward after stale active polling", () => {
    const initial = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({
        id: "note-1",
        processingStatus: "ready",
        generatedContent: "Finished notes",
      }),
    });

    const state = notesReducer(initial, {
      type: "noteUpdated",
      note: note({
        id: "note-1",
        processingStatus: "transcribing",
      }),
    });

    expect(state.selectedNote?.processingStatus).toBe("ready");
    expect(state.notes[0].processingStatus).toBe("ready");
  });

  it("tracks recording status transitions without changing selected note", () => {
    const initial = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({ id: "note-1" }),
    });
    const status: RecordingStatusDto = {
      sessionId: "session-1",
      state: "recording",
      elapsedMs: 1250,
      level: { peak: 0.4, rms: 0.2, recentPeaks: [0.1, 0.4] },
      silenceWarning: false,
      bytesWritten: 4096,
    };

    const state = notesReducer(initial, {
      type: "recordingStatusChanged",
      status,
    });

    expect(state.selectedNoteId).toBe("note-1");
    expect(state.recordingStatus).toEqual(status);
  });

  it("renames and deletes folders, keeping notes consistent", () => {
    const initial = notesReducer(createInitialState(), {
      type: "bootstrapLoaded",
      payload: {
        folders: [
          { id: "folder-1", name: "Inbox", createdAt: now, updatedAt: now },
          { id: "folder-2", name: "Archive", createdAt: now, updatedAt: now },
        ],
        notes: [
          { ...note({ id: "note-1", title: "A" }), folderIds: ["folder-1"] },
          {
            ...note({ id: "note-2", title: "B" }),
            folderIds: ["folder-1", "folder-2"],
          },
        ],
        activeRecoveries: [],
        providerConfigured: false,
      },
    });

    expect(initial.folders.map((folder) => folder.name)).toEqual([
      "Archive",
      "Inbox",
    ]);

    const renamed = notesReducer(initial, {
      type: "folderRenamed",
      folder: {
        id: "folder-1",
        name: "Triage",
        createdAt: now,
        updatedAt: now,
      },
    });
    expect(renamed.folders.map((folder) => folder.name)).toEqual([
      "Archive",
      "Triage",
    ]);

    const deleted = notesReducer(renamed, {
      type: "folderDeleted",
      folderId: "folder-1",
    });
    expect(deleted.folders.map((folder) => folder.id)).toEqual(["folder-2"]);
    expect(
      deleted.notes.find((item) => item.id === "note-2")?.folderIds,
    ).toEqual(["folder-2"]);
    expect(
      deleted.notes.find((item) => item.id === "note-1")?.folderIds,
    ).toEqual([]);
  });

  it("clears recording status after finish processing starts", () => {
    const status: RecordingStatusDto = {
      sessionId: "session-1",
      state: "recording",
      elapsedMs: 1250,
      level: { peak: 0.4, rms: 0.2, recentPeaks: [0.1, 0.4] },
      silenceWarning: false,
      bytesWritten: 4096,
    };
    const recording = notesReducer(createInitialState(), {
      type: "recordingStatusChanged",
      status,
    });

    const cleared = notesReducer(recording, { type: "recordingStatusCleared" });

    expect(cleared.recordingStatus).toBeUndefined();
  });

  it("clears the recorder when the backend lost the polled session", () => {
    const status: RecordingStatusDto = {
      sessionId: "session-1",
      state: "recording",
      elapsedMs: 1250,
      level: { peak: 0.4, rms: 0.2, recentPeaks: [0.1, 0.4] },
      silenceWarning: false,
      bytesWritten: 4096,
    };
    const recording = notesReducer(createInitialState(), {
      type: "recordingStatusChanged",
      status,
    });

    const lost = notesReducer(recording, {
      type: "recordingSessionLost",
      sessionId: "session-1",
    });

    expect(lost.recordingStatus).toBeUndefined();
  });

  it("ignores a lost-session signal for a superseded recording", () => {
    const status: RecordingStatusDto = {
      sessionId: "session-2",
      state: "recording",
      elapsedMs: 200,
      level: { peak: 0.4, rms: 0.2, recentPeaks: [0.1, 0.4] },
      silenceWarning: false,
      bytesWritten: 1024,
    };
    const recording = notesReducer(createInitialState(), {
      type: "recordingStatusChanged",
      status,
    });

    // A stale poll for the previous session must not tear down the bar for
    // the recording that replaced it.
    const state = notesReducer(recording, {
      type: "recordingSessionLost",
      sessionId: "session-1",
    });

    expect(state.recordingStatus).toEqual(status);
  });
});
