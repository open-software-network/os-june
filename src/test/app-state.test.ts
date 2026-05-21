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

  it("keeps updated notes visible when they remain in the selected folder", () => {
    const initial = notesReducer(createInitialState(), {
      type: "folderSelected",
      folderId: "folder-1",
    });
    const loaded = notesReducer(initial, {
      type: "noteLoaded",
      note: note({ folderIds: ["folder-1"] }),
    });

    const state = notesReducer(loaded, {
      type: "noteUpdated",
      note: note({ title: "In folder", folderIds: ["folder-1"] }),
    });

    expect(state.notes.map((item) => item.id)).toEqual(["note-1"]);
    expect(state.selectedNote?.title).toBe("In folder");
  });

  it("removes updated notes from the current folder view when unassigned", () => {
    const initial = notesReducer(createInitialState(), {
      type: "folderSelected",
      folderId: "folder-1",
    });
    const loaded = notesReducer(initial, {
      type: "noteLoaded",
      note: note({ folderIds: ["folder-1"] }),
    });

    const state = notesReducer(loaded, {
      type: "noteUpdated",
      note: note({ folderIds: [] }),
    });

    expect(state.notes).toEqual([]);
    expect(state.selectedNoteId).toBeUndefined();
    expect(state.selectedNote).toBeUndefined();
  });

  it("clears the selected note when it is deleted", () => {
    const loaded = notesReducer(createInitialState(), {
      type: "noteLoaded",
      note: note({ id: "note-1" }),
    });

    const state = notesReducer(loaded, {
      type: "noteDeleted",
      noteId: "note-1",
    });

    expect(state.notes).toEqual([]);
    expect(state.selectedNoteId).toBeUndefined();
    expect(state.selectedNote).toBeUndefined();
  });

  it("clears selected folder and note membership when a folder is deleted", () => {
    const initial = notesReducer(createInitialState(), {
      type: "bootstrapLoaded",
      payload: {
        folders: [
          { id: "folder-1", name: "Work", createdAt: now, updatedAt: now },
        ],
        notes: [note({ folderIds: ["folder-1"] })],
        activeRecoveries: [],
        providerConfigured: true,
      },
    });
    const selected = notesReducer(initial, {
      type: "folderSelected",
      folderId: "folder-1",
    });

    const state = notesReducer(selected, {
      type: "folderDeleted",
      folderId: "folder-1",
      deleteNotes: false,
    });

    expect(state.folders).toEqual([]);
    expect(state.selectedFolderId).toBeUndefined();
    expect(state.notes[0].folderIds).toEqual([]);
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
});
