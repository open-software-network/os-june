import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconNoteText } from "central-icons/IconNoteText";
import { useEffect, useMemo, useState } from "react";
import type { FolderDto, NoteListItemDto } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";

type AddNotesToFolderDialogProps = {
  open: boolean;
  onClose: () => void;
  folder: FolderDto;
  notes: NoteListItemDto[];
  /** Called once per note when the user commits the selection. */
  onAdd: (noteId: string) => Promise<unknown> | void;
};

export function AddNotesToFolderDialog({
  open,
  onClose,
  folder,
  notes,
  onAdd,
}: AddNotesToFolderDialogProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(new Set());
    setSubmitting(false);
  }, [open]);

  const candidates = useMemo(() => {
    const available = notes.filter(
      (note) => !note.folderIds.includes(folder.id),
    );
    const normalized = query.trim().toLowerCase();
    if (!normalized) return available;
    return available.filter((note) =>
      `${note.title} ${note.preview}`.toLowerCase().includes(normalized),
    );
  }, [notes, folder.id, query]);

  function toggle(noteId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }

  async function handleSubmit() {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      // Commit serially so backend assigns are deterministic and the
      // optimistic UI in the parent reducer applies in order.
      for (const noteId of selected) {
        await onAdd(noteId);
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const count = selected.size;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (submitting) return;
        onClose();
      }}
      title={`Add meeting notes to ${folder.name}`}
      description="Pick the meeting notes you want in this project."
      initialFocusSelector='input[name="add-notes-search"]'
      footer={
        <>
          <button
            type="button"
            className="primary-action"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void handleSubmit()}
            disabled={submitting || count === 0}
          >
            {submitting
              ? "Adding…"
              : count === 0
                ? "Add meeting notes"
                : `Add ${count} ${count === 1 ? "meeting note" : "meeting notes"}`}
          </button>
        </>
      }
    >
      <div className="add-notes-dialog">
        <label className="add-notes-search">
          <IconMagnifyingGlass size={14} />
          <input
            type="search"
            name="add-notes-search"
            placeholder="Search meeting notes"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            autoComplete="off"
          />
        </label>
        {candidates.length > 0 ? (
          <ul className="add-notes-list" role="listbox" aria-multiselectable>
            {candidates.map((note) => {
              const isSelected = selected.has(note.id);
              return (
                <li key={note.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="add-notes-row"
                    data-selected={isSelected}
                    onClick={() => toggle(note.id)}
                  >
                    <span className="add-notes-icon" aria-hidden>
                      <IconNoteText size={14} />
                    </span>
                    <span className="add-notes-body">
                      <span className="add-notes-title">
                        {note.title.trim() || "New note"}
                      </span>
                      <span className="add-notes-preview">
                        {note.preview.trim() ? note.preview : "No preview yet"}
                      </span>
                    </span>
                    <span className="add-notes-check" aria-hidden>
                      {isSelected ? <IconCheckmark1 size={12} /> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="add-notes-empty">
            {notes.some((note) => !note.folderIds.includes(folder.id))
              ? "No meeting notes match that search."
              : "Every meeting note already lives in this project."}
          </p>
        )}
      </div>
    </Dialog>
  );
}
