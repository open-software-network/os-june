import { X } from "lucide-react";
import type { NoteListItemDto } from "../../lib/tauri";

type NotesListProps = {
  notes: NoteListItemDto[];
  selectedNoteId?: string;
  emptyTitle?: string;
  onSelectNote: (noteId: string) => void;
  onDeleteNote: (note: NoteListItemDto) => void;
  onCreateNote: () => void;
};

export function NotesList({
  notes,
  selectedNoteId,
  emptyTitle = "No notes yet",
  onSelectNote,
  onDeleteNote,
  onCreateNote,
}: NotesListProps) {
  if (notes.length === 0) {
    return (
      <section className="notes-empty">
        <p>{emptyTitle}</p>
        <button type="button" className="primary-action" onClick={onCreateNote}>
          New note
        </button>
      </section>
    );
  }

  return (
    <section className="notes-list" aria-label="Notes">
      <button type="button" className="primary-action" onClick={onCreateNote}>
        New note
      </button>
      {notes.map((note) => {
        const title = note.title.trim() || "New note";
        const preview =
          note.preview.trim() || statusLabel(note.processingStatus);
        return (
          <article
            key={note.id}
            className={
              selectedNoteId === note.id
                ? "note-list-item selected"
                : "note-list-item"
            }
          >
            <button
              type="button"
              className="note-select-button"
              onClick={() => onSelectNote(note.id)}
            >
              <span>{title}</span>
              <small>{preview}</small>
            </button>
            <button
              type="button"
              className="icon-button danger"
              aria-label={`Delete note ${title}`}
              onClick={() => onDeleteNote(note)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </article>
        );
      })}
    </section>
  );
}

function statusLabel(status: NoteListItemDto["processingStatus"]) {
  switch (status) {
    case "recording":
      return "Recording";
    case "validating":
      return "Validating";
    case "transcribing":
      return "Transcribing";
    case "generating":
      return "Generating";
    case "failed":
      return "Needs attention";
    case "recoverable":
      return "Recoverable";
    case "ready":
      return "Ready";
    default:
      return "Draft";
  }
}
