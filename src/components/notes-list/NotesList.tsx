import { IconFileText } from "central-icons/IconFileText";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useMemo, useState } from "react";
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
  const [query, setQuery] = useState("");
  const filteredNotes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const sorted = [...notes].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    if (!normalized) return sorted;
    return sorted.filter((note) => {
      return `${note.title} ${note.preview}`.toLowerCase().includes(normalized);
    });
  }, [notes, query]);

  return (
    <section className="all-notes-workspace" aria-label="Notes">
      <header className="folders-header">
        <div className="folders-heading">
          <h1>Notes</h1>
          <p className="folders-subtitle">
            {notes.length} {notes.length === 1 ? "note" : "notes"} across your
            workspace.
          </p>
        </div>
        <button
          type="button"
          className="primary-action primary-solid folders-create"
          onClick={onCreateNote}
        >
          <IconPlusMedium size={13} />
          New note
        </button>
      </header>

      {notes.length > 0 ? (
        <div className="folders-controls">
          <label className="folders-search">
            <IconMagnifyingGlass size={14} />
            <input
              type="search"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>
      ) : null}

      {notes.length === 0 ? (
        <div className="folders-empty">
          <p>No notes yet.</p>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={onCreateNote}
          >
            <IconPlusMedium size={13} />
            Create your first note
          </button>
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="folders-empty">
          <p>No notes match “{query.trim()}”.</p>
        </div>
      ) : (
        <ul className="folder-notes all-notes-list" role="list">
          {filteredNotes.map((note) => (
            <AllNoteRow
              key={note.id}
              note={note}
              selected={selectedNoteId === note.id}
              onSelect={() => onSelectNote(note.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AllNoteRow({
  note,
  selected,
  onSelect,
}: {
  note: NoteListItemDto;
  selected: boolean;
  onSelect: () => void;
}) {
  const title = note.title.trim() || "New note";
  const preview = note.preview.trim() || statusLabel(note.processingStatus);

  return (
    <li>
      <div className="folder-note-row all-notes-row" data-selected={selected}>
        <button type="button" className="folder-note-main" onClick={onSelect}>
          <span className="folder-note-icon" aria-hidden>
            <IconFileText size={14} />
          </span>
          <span className="folder-note-body">
            <span className="folder-note-title">{title}</span>
            <span className="folder-note-subtitle">{preview}</span>
          </span>
        </button>
        <span className="folder-note-time">
          {formatNoteTime(note.updatedAt)}
        </span>
      </div>
    </li>
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

function formatNoteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return "Future";
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
