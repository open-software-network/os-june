import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoteActions } from "../app/note-actions";
import type { CreateNoteActionsDependencies } from "../app/note-actions-types";
import { NoteSaveController } from "../app/note-save-controller";
import { createInitialState } from "../app/state/app-state";
import type { NoteEditablePatch, NotePatchDto } from "../lib/tauri";

const tauriMocks = vi.hoisted(() => ({
  deleteNote: vi.fn(),
  deleteNotes: vi.fn(),
  getNote: vi.fn(),
  listNotes: vi.fn(),
}));

vi.mock("../lib/tauri", () => tauriMocks);

function persistedPatch(noteId: string, patch: NoteEditablePatch): NotePatchDto {
  return {
    id: noteId,
    title: patch.title ?? "Existing title",
    preview: patch.editedContent ?? patch.title ?? "Existing preview",
    editedContent: patch.editedContent,
    activeTab: patch.activeTab ?? "notes",
    updatedAt: "2026-07-23T10:00:00.000Z",
  };
}

function dependencies(
  noteSaveController: NoteSaveController,
  setError: ReturnType<typeof vi.fn>,
): CreateNoteActionsDependencies {
  return {
    dispatch: vi.fn(),
    handleEmptyNotesAfterDelete: vi.fn(),
    noteSaveController,
    pruneDeletedNoteTabs: vi.fn(),
    setActiveView: vi.fn(),
    setError,
    setFolderReturnTarget: vi.fn(),
    setOriginAllNotes: vi.fn(),
    setOriginFolderId: vi.fn(),
    state: createInitialState(),
  };
}

describe("note deletion actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not delete or discard a note when its final save fails", async () => {
    vi.useFakeTimers();
    const controller = new NoteSaveController({
      persist: vi.fn().mockRejectedValue(new Error("database busy")),
    });
    const discard = vi.spyOn(controller, "discard");
    const setError = vi.fn();
    const actions = createNoteActions(dependencies(controller, setError));
    controller.queue("note-1", { title: "Unsaved title" });

    await actions.handleDeleteNote("note-1");

    expect(tauriMocks.deleteNote).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(controller.hasPending("note-1")).toBe(true);
    expect(setError).toHaveBeenCalledWith("database busy");
    controller.discard("note-1");
  });

  it("does not bulk delete when any note's final save fails", async () => {
    vi.useFakeTimers();
    const controller = new NoteSaveController({
      persist: async (noteId, patch) => {
        if (noteId === "note-1") throw new Error("database busy");
        return persistedPatch(noteId, patch);
      },
    });
    const setError = vi.fn();
    const actions = createNoteActions(dependencies(controller, setError));
    controller.queue("note-1", { title: "Unsaved first note" });
    controller.queue("note-2", { title: "Saved second note" });

    await actions.handleDeleteNotes(["note-1", "note-2"]);

    expect(tauriMocks.deleteNotes).not.toHaveBeenCalled();
    expect(controller.hasPending("note-1")).toBe(true);
    expect(setError).toHaveBeenCalledWith("database busy");
    controller.discard("note-1");
    controller.discard("note-2");
  });
});
