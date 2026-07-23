import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTE_SAVE_DEBOUNCE_MS, NoteSaveController } from "../app/note-save-controller";
import type { NoteEditablePatch, NotePatchDto } from "../lib/tauri";

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

describe("NoteSaveController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces title and content edits into one note patch", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async (noteId: string, patch: NoteEditablePatch) =>
      persistedPatch(noteId, patch),
    );
    const controller = new NoteSaveController({ persist });

    controller.queue("note-1", { title: "First" });
    controller.queue("note-1", { title: "Final", editedContent: "Body" });

    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS - 1);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("note-1", {
      title: "Final",
      editedContent: "Body",
    });
  });

  it("flushes the current note immediately for blur or navigation", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async (noteId: string, patch: NoteEditablePatch) =>
      persistedPatch(noteId, patch),
    );
    const controller = new NoteSaveController({ persist });

    controller.queue("note-1", { title: "Saved before leaving" });
    await controller.flush("note-1");

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("note-1", {
      title: "Saved before leaving",
    });
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("flushes every pending note before app shutdown", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async (noteId: string, patch: NoteEditablePatch) =>
      persistedPatch(noteId, patch),
    );
    const controller = new NoteSaveController({ persist });

    controller.queue("note-1", { title: "First note" });
    controller.queue("note-2", { editedContent: "Second note body" });
    await controller.flushAll();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith("note-1", { title: "First note" });
    expect(persist).toHaveBeenCalledWith("note-2", {
      editedContent: "Second note body",
    });
    expect(controller.hasPending()).toBe(false);
  });

  it("serializes edits queued while a save is in flight", async () => {
    let finishFirst: ((patch: NotePatchDto) => void) | undefined;
    const persist = vi
      .fn<(noteId: string, patch: NoteEditablePatch) => Promise<NotePatchDto>>()
      .mockImplementationOnce(
        (noteId, patch) =>
          new Promise((resolve) => {
            finishFirst = resolve;
            expect(persistedPatch(noteId, patch).title).toBe("First");
          }),
      )
      .mockImplementation(async (noteId, patch) => persistedPatch(noteId, patch));
    const controller = new NoteSaveController({ persist, debounceMs: 0 });

    controller.queue("note-1", { title: "First" });
    const firstFlush = controller.flush("note-1");
    controller.queue("note-1", { title: "Second" });
    const finalFlush = controller.flush("note-1");
    finishFirst?.(persistedPatch("note-1", { title: "First" }));
    await Promise.all([firstFlush, finalFlush]);

    expect(persist).toHaveBeenNthCalledWith(1, "note-1", { title: "First" });
    expect(persist).toHaveBeenNthCalledWith(2, "note-1", { title: "Second" });
  });
});
