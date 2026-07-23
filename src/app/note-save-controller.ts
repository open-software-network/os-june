import type { NoteEditablePatch, NotePatchDto } from "../lib/tauri";

export const NOTE_SAVE_DEBOUNCE_MS = 500;

type NoteSaveControllerOptions = {
  persist: (noteId: string, patch: NoteEditablePatch) => Promise<NotePatchDto>;
  onPersisted?: (patch: NotePatchDto) => void;
  onError?: (error: unknown, noteId: string) => void;
  debounceMs?: number;
};

/**
 * Coalesces note-row edits per note and serializes writes for the same note.
 *
 * The queue is note-keyed rather than selection-keyed: a blur caused by
 * navigation can safely finish saving the editor that is being torn down
 * without writing its content into the newly selected note.
 */
export class NoteSaveController {
  private readonly pending = new Map<string, NoteEditablePatch>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly debounceMs: number;

  constructor(private readonly options: NoteSaveControllerOptions) {
    this.debounceMs = options.debounceMs ?? NOTE_SAVE_DEBOUNCE_MS;
  }

  queue(noteId: string, patch: NoteEditablePatch) {
    if (!hasPatchFields(patch)) return;
    this.pending.set(noteId, {
      ...this.pending.get(noteId),
      ...patch,
    });
    this.clearTimer(noteId);
    this.timers.set(
      noteId,
      setTimeout(() => {
        this.timers.delete(noteId);
        void this.drain(noteId);
      }, this.debounceMs),
    );
  }

  async saveNow(noteId: string, patch: NoteEditablePatch) {
    this.queue(noteId, patch);
    await this.flush(noteId);
  }

  async flush(noteId: string) {
    this.clearTimer(noteId);
    await this.drain(noteId);
  }

  async flushAll() {
    for (const noteId of this.timers.keys()) {
      this.clearTimer(noteId);
    }
    const noteIds = new Set([...this.pending.keys(), ...this.inFlight.keys()]);
    await Promise.all([...noteIds].map((noteId) => this.drain(noteId)));
  }

  hasPending(noteId?: string) {
    if (noteId) {
      return this.pending.has(noteId) || this.inFlight.has(noteId);
    }
    return this.pending.size > 0 || this.inFlight.size > 0;
  }

  discard(noteId: string) {
    this.clearTimer(noteId);
    this.pending.delete(noteId);
  }

  private async drain(noteId: string): Promise<void> {
    const active = this.inFlight.get(noteId);
    if (active) {
      const succeeded = await active;
      if (succeeded && this.pending.has(noteId)) {
        await this.drain(noteId);
      }
      return;
    }

    const patch = this.pending.get(noteId);
    if (!patch) return;
    this.pending.delete(noteId);

    const operation = this.persist(noteId, patch);
    this.inFlight.set(noteId, operation);
    const succeeded = await operation;
    if (this.inFlight.get(noteId) === operation) {
      this.inFlight.delete(noteId);
    }
    if (succeeded && this.pending.has(noteId)) {
      await this.drain(noteId);
    }
  }

  private async persist(noteId: string, patch: NoteEditablePatch): Promise<boolean> {
    try {
      const persisted = await this.options.persist(noteId, patch);
      this.options.onPersisted?.({
        ...persisted,
        ...this.pending.get(noteId),
      });
      return true;
    } catch (error) {
      // Keep the failed fields available for the next edit/flush. Newer values
      // win when the user changed the same field while this write was running.
      this.pending.set(noteId, {
        ...patch,
        ...this.pending.get(noteId),
      });
      this.options.onError?.(error, noteId);
      return false;
    }
  }

  private clearTimer(noteId: string) {
    const timer = this.timers.get(noteId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(noteId);
    }
  }
}

function hasPatchFields(patch: NoteEditablePatch) {
  return (
    patch.title !== undefined || patch.editedContent !== undefined || patch.activeTab !== undefined
  );
}
