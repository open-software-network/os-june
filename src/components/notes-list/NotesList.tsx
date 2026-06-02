import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useMemo, useState } from "react";
import type { NoteListItemDto } from "../../lib/tauri";

type NotesListProps = {
  notes: NoteListItemDto[];
  selectedNoteId?: string;
  onSelectNote: (noteId: string) => void;
  onCreateNote: () => void;
  onOpenMoveDialog: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
};

export function NotesList({
  notes,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  onOpenMoveDialog,
  onDeleteNote,
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
          <h1>
            Notes
            {notes.length > 0 ? (
              <span className="folders-count">{notes.length}</span>
            ) : null}
          </h1>
          <p className="folders-subtitle">Everything across your workspace.</p>
        </div>
        <button
          type="button"
          className="primary-action primary-solid folders-create"
          onClick={onCreateNote}
        >
          <IconPlusMedium size={13} />
          New note
          <kbd className="primary-action-kbd" aria-hidden>
            ⌘N
          </kbd>
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
              onOpenMove={() => onOpenMoveDialog(note.id)}
              onDelete={() => onDeleteNote(note.id)}
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
  onOpenMove,
  onDelete,
}: {
  note: NoteListItemDto;
  selected: boolean;
  onSelect: () => void;
  onOpenMove: () => void;
  onDelete: () => void;
}) {
  const title = note.title.trim() || "New note";
  const preview = note.preview.trim() || statusLabel(note.processingStatus);
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <li>
      <div
        className="folder-note-row all-notes-row"
        data-selected={selected}
        data-has-actions="true"
        data-menu-open={menu !== null}
      >
        <button type="button" className="folder-note-main" onClick={onSelect}>
          <span className="folder-note-icon" aria-hidden>
            <IconNoteText size={14} />
          </span>
          <span className="folder-note-body">
            <span className="folder-note-title">{title}</span>
            <span className="folder-note-subtitle">{preview}</span>
          </span>
        </button>
        <span className="folder-note-time">
          {formatNoteTime(note.updatedAt)}
        </span>
        <span className="folder-note-actions">
          <button
            type="button"
            className="folder-note-menu"
            aria-label={`Actions for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (menu) {
                setMenu(null);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                right: window.innerWidth - rect.right,
                top: rect.bottom + 4,
              });
            }}
          >
            <IconDotGrid1x3Horizontal size={13} />
          </button>
        </span>
        {menu ? (
          <div
            className="context-menu"
            style={{ right: menu.right, top: menu.top }}
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onOpenMove();
              }}
            >
              <IconMoveFolder size={14} />
              Move to folder
            </button>
            <div className="context-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="destructive"
              onClick={() => {
                setMenu(null);
                if (
                  window.confirm(`Delete "${title}"? This cannot be undone.`)
                ) {
                  onDelete();
                }
              }}
            >
              <IconTrashCan size={14} />
              Delete note
            </button>
          </div>
        ) : null}
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
