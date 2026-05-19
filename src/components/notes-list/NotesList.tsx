import type { NoteListItemDto } from "../../lib/tauri";

type NotesListProps = {
  notes: NoteListItemDto[];
  selectedNoteId?: string;
  onSelectNote: (noteId: string) => void;
  onCreateNote: () => void;
};

export function NotesList({
  notes,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
}: NotesListProps) {
  if (notes.length === 0) {
    return (
      <section className="notes-empty">
        <p>No notes yet</p>
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
          <button
            key={note.id}
            type="button"
            className={selectedNoteId === note.id ? "selected" : undefined}
            onClick={() => onSelectNote(note.id)}
          >
            <span>{title}</span>
            <small>{preview}</small>
          </button>
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
