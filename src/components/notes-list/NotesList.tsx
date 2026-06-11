import { IconCheckmark2Medium } from "central-icons-filled/IconCheckmark2Medium";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useMemo, useState } from "react";
import type { NoteListItemDto } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";

type NotesListProps = {
  notes: NoteListItemDto[];
  selectedNoteId?: string;
  onSelectNote: (noteId: string) => void;
  onCreateNote: () => void;
  onOpenMoveDialog: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDeleteNotes: (noteIds: string[]) => void | Promise<unknown>;
};

type MenuPosition = {
  right: number;
  top: number;
};

type OpenMenu = MenuPosition & {
  noteId: string;
};

const CONTEXT_MENU_WIDTH = 156;
const MEETING_MENU_HEIGHT = 74;
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

export function NotesList({
  notes,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  onOpenMoveDialog,
  onDeleteNote,
  onDeleteNotes,
}: NotesListProps) {
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const sortedNotes = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [notes],
  );
  const filteredNotes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sortedNotes;
    return sortedNotes.filter((note) => {
      return `${note.title} ${note.preview}`.toLowerCase().includes(normalized);
    });
  }, [sortedNotes, query]);

  const selectedNoteIds = useMemo(
    () =>
      sortedNotes
        .filter((note) => selectedIds.has(note.id))
        .map((note) => note.id),
    [sortedNotes, selectedIds],
  );
  const visibleSelectedCount = filteredNotes.filter((note) =>
    selectedIds.has(note.id),
  ).length;
  const selectedCount = selectedNoteIds.length;
  const hasUnselectedVisibleNotes =
    filteredNotes.length > 0 && visibleSelectedCount < filteredNotes.length;
  const allVisibleNotesSelected =
    filteredNotes.length > 0 && visibleSelectedCount === filteredNotes.length;

  useEffect(() => {
    const noteIds = new Set(notes.map((note) => note.id));
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => noteIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    if (notes.length === 0) {
      setConfirmBulkDelete(false);
    }
  }, [notes]);

  function toggleSelected(noteId: string) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }

  function resetSelection() {
    setSelectedIds(new Set());
    setConfirmBulkDelete(false);
  }

  function selectAllVisibleNotes() {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const note of filteredNotes) {
        next.add(note.id);
      }
      return next;
    });
  }

  function deselectAllVisibleNotes() {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const note of filteredNotes) {
        next.delete(note.id);
      }
      return next;
    });
  }

  return (
    <section className="all-notes-workspace" aria-label="Meetings">
      <header className="folders-header">
        <div className="folders-heading">
          <h1>
            Meetings
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
          New meeting
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
          <div className="meetings-bulk-actions">
            {selectedCount > 0 ? (
              <>
                <span className="meetings-selected-count">
                  {selectedCount} selected
                </span>
                {hasUnselectedVisibleNotes ? (
                  <button
                    type="button"
                    className="primary-action"
                    onClick={selectAllVisibleNotes}
                  >
                    Select all
                  </button>
                ) : null}
                {allVisibleNotesSelected ? (
                  <button
                    type="button"
                    className="primary-action"
                    onClick={deselectAllVisibleNotes}
                  >
                    Deselect all
                  </button>
                ) : null}
                <button
                  type="button"
                  className="primary-action"
                  onClick={resetSelection}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-action primary-solid primary-destructive"
                  disabled={selectedCount === 0}
                  onClick={() => setConfirmBulkDelete(true)}
                >
                  <IconTrashCan size={13} />
                  {selectedCount === 1
                    ? "Delete 1 meeting"
                    : `Delete ${selectedCount} meetings`}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {notes.length === 0 ? (
        <div className="folders-empty">
          <p>No meetings yet.</p>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={onCreateNote}
          >
            <IconPlusMedium size={13} />
            Create your first meeting
          </button>
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="folders-empty">
          <p>No meetings match “{query.trim()}”.</p>
        </div>
      ) : (
        <ul className="folder-notes all-notes-list" role="list">
          {filteredNotes.map((note) => (
            <AllNoteRow
              key={note.id}
              note={note}
              selected={selectedNoteId === note.id}
              menu={
                openMenu?.noteId === note.id
                  ? { right: openMenu.right, top: openMenu.top }
                  : null
              }
              onSelect={() => onSelectNote(note.id)}
              checked={selectedIds.has(note.id)}
              onToggleSelected={() => toggleSelected(note.id)}
              onOpenMenu={(position) =>
                setOpenMenu({ noteId: note.id, ...position })
              }
              onCloseMenu={() => setOpenMenu(null)}
              onOpenMove={() => onOpenMoveDialog(note.id)}
              onDelete={() => onDeleteNote(note.id)}
            />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={async () => {
          await onDeleteNotes(selectedNoteIds);
          resetSelection();
        }}
        title={`Delete ${selectedCount} ${
          selectedCount === 1 ? "meeting" : "meetings"
        }?`}
        description="This cannot be undone. Audio, transcripts, and generated notes for these meetings will be removed."
        confirmLabel={
          selectedCount === 1 ? "Delete meeting" : "Delete meetings"
        }
        destructive
      />
    </section>
  );
}

function AllNoteRow({
  note,
  selected,
  menu,
  onSelect,
  checked,
  onToggleSelected,
  onOpenMenu,
  onCloseMenu,
  onOpenMove,
  onDelete,
}: {
  note: NoteListItemDto;
  selected: boolean;
  menu: MenuPosition | null;
  onSelect: () => void;
  checked: boolean;
  onToggleSelected: () => void;
  onOpenMenu: (position: MenuPosition) => void;
  onCloseMenu: () => void;
  onOpenMove: () => void;
  onDelete: () => void;
}) {
  const title = note.title.trim() || "New meeting";
  const preview = note.preview.trim() || statusLabel(note.processingStatus);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!menu) return;
    function close() {
      onCloseMenu();
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
  }, [menu, onCloseMenu]);

  return (
    <li>
      <div
        className="folder-note-row all-notes-row"
        data-selected={selected || checked}
        data-has-actions="true"
        data-menu-open={menu !== null}
      >
        <label className="folder-note-checkbox">
          <input
            type="checkbox"
            checked={checked}
            aria-label={`Select ${title}`}
            onChange={onToggleSelected}
          />
          <span className="folder-note-select-box" aria-hidden>
            {checked ? <IconCheckmark2Medium size={11} /> : null}
          </span>
        </label>
        <button type="button" className="folder-note-main" onClick={onSelect}>
          <MeetingRowContent title={title} preview={preview} />
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
                onCloseMenu();
                return;
              }
              onOpenMenu(meetingMenuPosition(event.currentTarget));
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
                onCloseMenu();
                onOpenMove();
              }}
            >
              <IconMoveFolder size={14} />
              Move to project
            </button>
            <div className="context-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="destructive"
              onClick={() => {
                onCloseMenu();
                setConfirmDelete(true);
              }}
            >
              <IconTrashCan size={14} />
              Delete meeting
            </button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        title={`Delete "${title}"?`}
        description="This cannot be undone."
        confirmLabel="Delete meeting"
        destructive
      />
    </li>
  );
}

function MeetingRowContent({
  title,
  preview,
}: {
  title: string;
  preview: string;
}) {
  return (
    <>
      <span className="folder-note-icon" aria-hidden>
        <IconNoteText size={14} />
      </span>
      <span className="folder-note-body">
        <span className="folder-note-title">{title}</span>
        <span className="folder-note-subtitle">{preview}</span>
      </span>
    </>
  );
}

function meetingMenuPosition(trigger: HTMLElement): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  const maxRight = Math.max(
    VIEWPORT_MARGIN,
    window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_MARGIN,
  );
  const right = Math.min(
    Math.max(window.innerWidth - rect.left + MENU_GAP, VIEWPORT_MARGIN),
    maxRight,
  );
  const belowTop = rect.bottom + MENU_GAP;
  const top =
    belowTop + MEETING_MENU_HEIGHT <= window.innerHeight - VIEWPORT_MARGIN
      ? belowTop
      : rect.top - MEETING_MENU_HEIGHT - MENU_GAP;

  return {
    right,
    top: Math.max(VIEWPORT_MARGIN, top),
  };
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
