import { IconCheckmark2Medium } from "central-icons-filled/IconCheckmark2Medium";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCan } from "central-icons/IconTrashCan";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NoteListItemDto } from "../../lib/tauri";
import { useForcedEmptyStates } from "../../lib/empty-states-demo";
import { primaryShiftShortcutLabel } from "../../lib/platform";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";

const NO_NOTES: NoteListItemDto[] = [];

type NotesListProps = {
  notes: NoteListItemDto[];
  onSelectNote: (noteId: string) => void;
  onCreateNote: () => void;
  onOpenMoveDialog: (noteId: string) => void;
  onOpenMoveNotes: (noteIds: string[]) => void;
  onDeleteNote: (noteId: string) => void;
  onDeleteNotes: (noteIds: string[]) => void | Promise<unknown>;
};

export type NotesListHandle = {
  resetSelection: () => void;
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

export const NotesList = forwardRef<NotesListHandle, NotesListProps>(
  function NotesList(
    {
      notes: allNotes,
      onSelectNote,
      onCreateNote,
      onOpenMoveDialog,
      onOpenMoveNotes,
      onDeleteNote,
      onDeleteNotes,
    },
    ref,
  ) {
    // __emptyStates() preview (dev console): render the page as a fresh
    // install would see it, real data untouched underneath.
    const notes = useForcedEmptyStates() ? NO_NOTES : allNotes;
    const [query, setQuery] = useState("");
    const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
    // The bar plays one of two exits when the selection ends. A deliberate
    // dismiss (×, Escape, post-delete) slides out; the selection merely emptying
    // (deselect all, unchecking the last row) fades. We capture the cause the
    // moment the selection drops to zero, keep the bar mounted with data-exit,
    // and unmount when its animation finishes.
    const [exit, setExit] = useState<null | "slide" | "fade">(null);
    const createNoteShortcut = primaryShiftShortcutLabel("N");
    // The cause of the *next* empty transition, latched by the call sites.
    // Toggling a row can't know it's the last box until the set settles, so
    // unchecking defaults to fade unless a dismiss intent was latched first.
    const exitCauseRef = useRef<"slide" | "fade">("fade");

    const sortedNotes = useMemo(
      () => [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      [notes],
    );
    const filteredNotes = useMemo(() => {
      const normalized = query.trim().toLowerCase();
      if (!normalized) return sortedNotes;
      return sortedNotes.filter((note) => {
        return `${note.title} ${note.preview}`
          .toLowerCase()
          .includes(normalized);
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

    // Snapshot the last nonzero count so the exiting bar keeps its real label
    // instead of flashing "0 selected".
    const lastCountRef = useRef(selectedCount);
    if (selectedCount > 0) lastCountRef.current = selectedCount;
    const displayCount =
      selectedCount > 0 ? selectedCount : lastCountRef.current;

    // Drive the exit/cancel transitions off the live count. Selecting again
    // mid-exit cancels the exit and replays the live bar. The previous-count
    // guard keeps the initial mount (0, with nothing to exit from) from arming
    // a ghost exit.
    const previousCountRef = useRef(0);
    useEffect(() => {
      const previousCount = previousCountRef.current;
      previousCountRef.current = selectedCount;
      if (selectedCount > 0) {
        setExit(null);
        return;
      }
      if (previousCount === 0) return;
      const cause = exitCauseRef.current;
      exitCauseRef.current = "fade";
      setExit((current) => current ?? cause);
    }, [selectedCount]);

    const barMounted = selectedCount > 0 || exit !== null;
    const isExiting = selectedCount === 0 && exit !== null;

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

    // A deliberate dismiss — ×, Escape, post-delete — slides the bar out.
    const resetSelection = useCallback(() => {
      exitCauseRef.current = "slide";
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
    }, []);

    useImperativeHandle(ref, () => ({ resetSelection }), [resetSelection]);

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

    // Escape clears an active selection. Skipped while the bulk-delete confirm
    // dialog is open so the two don't fight over the same keypress — there the
    // dialog owns Escape (it dismisses itself, leaving the selection intact).
    useEffect(() => {
      if (selectedCount === 0 || confirmBulkDelete) return;
      function onKey(event: KeyboardEvent) {
        if (event.key === "Escape") resetSelection();
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [selectedCount, confirmBulkDelete]);

    return (
      <section className="all-notes-workspace" aria-label="Meeting notes">
        <header className="folders-header">
          <div className="folders-heading">
            <h1>
              Meeting notes
              {notes.length > 0 ? (
                <span className="folders-count">{notes.length}</span>
              ) : null}
            </h1>
            <p className="folders-subtitle">
              Everything across your workspace.
            </p>
          </div>
          <button
            type="button"
            className="primary-action primary-solid folders-create"
            onClick={onCreateNote}
          >
            <IconPlusMedium size={13} />
            New note
            <kbd className="primary-action-kbd" aria-hidden>
              {createNoteShortcut}
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
          <EmptyState
            label="Create your first note"
            icon={<IconNoteText size={28} />}
            title="Capture your first meeting"
            description="Record a meeting, a phone call, or a half-formed thought. June transcribes it and writes the note for you."
            action={
              <button
                type="button"
                className="primary-action primary-solid"
                onClick={onCreateNote}
              >
                <IconPlusMedium size={13} />
                Create your first note
              </button>
            }
          />
        ) : filteredNotes.length === 0 ? (
          <div className="folders-empty">
            <p>No notes match “{query.trim()}”.</p>
          </div>
        ) : (
          <ul
            className="folder-notes all-notes-list"
            role="list"
            data-selecting={selectedCount > 0}
          >
            {filteredNotes.map((note) => (
              <AllNoteRow
                key={note.id}
                note={note}
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

        {barMounted ? (
          <div
            className="meetings-bulk-bar"
            role="toolbar"
            aria-label="Selection"
            data-exit={isExiting ? exit : undefined}
            onAnimationEnd={(event) => {
              // Only the bar's own exit keyframes unmount it. Child button
              // hovers fire transitionend, not animationend, but a descendant
              // animation could still bubble here — so require the event to
              // originate on the bar and, when the name is reported, to be an
              // exit keyframe. (jsdom omits animationName, hence the optional
              // check rather than a hard requirement.)
              if (!isExiting || event.target !== event.currentTarget) return;
              if (
                event.animationName &&
                !event.animationName.startsWith("meetings-bulk-bar-out")
              ) {
                return;
              }
              setExit(null);
            }}
          >
            <span className="meetings-bulk-count">{displayCount} selected</span>
            {hasUnselectedVisibleNotes ? (
              <button
                type="button"
                className="meetings-bulk-action"
                onClick={selectAllVisibleNotes}
              >
                Select all
              </button>
            ) : null}
            <button
              type="button"
              className="meetings-bulk-action"
              onClick={deselectAllVisibleNotes}
            >
              Deselect all
            </button>
            <button
              type="button"
              className="meetings-bulk-action"
              onClick={() => onOpenMoveNotes(selectedNoteIds)}
            >
              Move
            </button>
            <button
              type="button"
              className="meetings-bulk-action"
              onClick={() => setConfirmBulkDelete(true)}
            >
              Delete
            </button>
            <button
              type="button"
              className="meetings-bulk-dismiss"
              aria-label="Clear selection"
              onClick={resetSelection}
            >
              <IconCrossMedium size={14} />
            </button>
          </div>
        ) : null}

        <ConfirmDialog
          open={confirmBulkDelete}
          onClose={() => setConfirmBulkDelete(false)}
          onConfirm={async () => {
            await onDeleteNotes(selectedNoteIds);
            resetSelection();
          }}
          title={`Delete ${selectedCount} ${
            selectedCount === 1 ? "note" : "notes"
          }?`}
          description="This cannot be undone. Audio, transcripts, and generated notes for these notes will be removed."
          confirmLabel={selectedCount === 1 ? "Delete note" : "Delete notes"}
          destructive
        />
      </section>
    );
  },
);

function AllNoteRow({
  note,
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
  menu: MenuPosition | null;
  onSelect: () => void;
  checked: boolean;
  onToggleSelected: () => void;
  onOpenMenu: (position: MenuPosition) => void;
  onCloseMenu: () => void;
  onOpenMove: () => void;
  onDelete: () => void;
}) {
  const title = note.title.trim() || "New note";
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
        data-selected={checked}
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
            {checked ? <IconCheckmark2Medium size={10} /> : null}
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
              Delete note
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
        confirmLabel="Delete note"
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
