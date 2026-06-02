import { IconDotGrid1x3Vertical } from "central-icons/IconDotGrid1x3Vertical";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";
import { IconFolders } from "central-icons/IconFolders";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { NOTE_DND_MIME } from "../../lib/dnd";
import type { FolderDto, NoteListItemDto } from "../../lib/tauri";

export type SidebarView =
  | "notes"
  | "all-notes"
  | "settings"
  | "folders"
  | "dictation";

type SidebarProps = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  selectedNoteId?: string;
  selectedFolderId?: string;
  activeView: SidebarView;
  onChangeView: (view: SidebarView) => void;
  onCreateFolder: () => void;
  onCreateNote: () => void;
  onSelectAll: () => void;
  onSelectFolder: (folderId: string) => void;
  onSelectNote: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onOpenMoveDialog: (noteId: string) => void;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  recoverableNoteIds?: ReadonlySet<string>;
  collapsed?: boolean;
};

type MenuState = {
  noteId: string;
  right: number;
  top: number;
};

export function Sidebar({
  folders,
  notes,
  selectedNoteId,
  activeView,
  onChangeView,
  onCreateNote,
  onSelectNote,
  onDeleteNote,
  onOpenMoveDialog,
  onRemoveNoteFromFolder,
  recoverableNoteIds,
  collapsed = false,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const filteredNotes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return notes;
    return notes.filter((note) =>
      `${note.title} ${note.preview}`.toLowerCase().includes(normalized),
    );
  }, [notes, query]);

  useEffect(() => {
    if (!menu) return;

    function close() {
      setMenu(null);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }

    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  // Right-aligns the popover with the overflow button and parks it just
  // below — keeps it tucked next to the trigger rather than flying off to
  // the right. Clicking the same button again toggles it closed.
  function openMenuForNote(noteId: string, anchor: HTMLElement) {
    if (menu?.noteId === noteId) {
      setMenu(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setMenu({
      noteId,
      right: window.innerWidth - rect.right,
      top: rect.bottom + 4,
    });
  }

  return (
    <aside className="sidebar" data-collapsed={collapsed}>
      <header className="sidebar-header">
        <a className="sidebar-brand" href="#" aria-label="Scribe">
          <img
            className="sidebar-brand-img light"
            src="/os-scribe-light.svg"
            alt=""
            height={16}
          />
          <img
            className="sidebar-brand-img dark"
            src="/os-scribe-dark.svg"
            alt=""
            height={16}
          />
          <span style={{ position: "absolute", left: -9999 }}>Scribe</span>
        </a>
      </header>

      <label className="sidebar-search">
        <IconMagnifyingGlass size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search"
        />
      </label>

      <nav className="sidebar-nav" aria-label="Primary">
        <button
          type="button"
          className="sidebar-nav-item"
          onClick={() => {
            onChangeView("notes");
            onCreateNote();
          }}
        >
          <span className="sidebar-nav-icon">
            <IconPlusMedium size={15} />
          </span>
          <span className="sidebar-nav-label">New note</span>
          <kbd className="sidebar-search-kbd sidebar-nav-shortcut" aria-hidden>
            ⌘N
          </kbd>
        </button>
        <button
          type="button"
          className="sidebar-nav-item"
          data-active={activeView === "folders"}
          aria-current={activeView === "folders" ? "page" : undefined}
          onClick={() => onChangeView("folders")}
        >
          <span className="sidebar-nav-icon">
            <IconFolders size={16} />
          </span>
          <span className="sidebar-nav-label">Folders</span>
        </button>
        <button
          type="button"
          className="sidebar-nav-item"
          data-active={activeView === "dictation"}
          aria-current={activeView === "dictation" ? "page" : undefined}
          onClick={() => onChangeView("dictation")}
        >
          <span className="sidebar-nav-icon">
            <IconMicrophone size={16} />
          </span>
          <span className="sidebar-nav-label">Dictation</span>
        </button>
      </nav>

      <section
        className="sidebar-section"
        aria-label="Notes"
        data-active={activeView === "notes"}
      >
        <div className="section-title section-title-with-action">
          <button
            type="button"
            className="section-title-label section-title-open"
            onClick={() => onChangeView("all-notes")}
          >
            Notes <span className="section-count">{notes.length}</span>
          </button>
          <button
            type="button"
            className="section-view-all"
            onClick={() => onChangeView("all-notes")}
          >
            View all
          </button>
        </div>
        <div className="notes-nav-wrap">
          <div className="notes-nav">
            {filteredNotes.length > 0 ? (
              filteredNotes.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  selected={
                    activeView === "notes" && selectedNoteId === note.id
                  }
                  recoverable={recoverableNoteIds?.has(note.id) ?? false}
                  onSelect={() => {
                    onChangeView("notes");
                    onSelectNote(note.id);
                  }}
                  onOpenMenu={(anchor) => openMenuForNote(note.id, anchor)}
                />
              ))
            ) : (
              <div className="sidebar-empty">
                {notes.length === 0 ? "No notes yet" : "No matches"}
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="sidebar-footer">
        <button
          type="button"
          className="sidebar-nav-item"
          data-active={activeView === "settings"}
          aria-current={activeView === "settings" ? "page" : undefined}
          aria-label="Settings"
          onClick={() => onChangeView("settings")}
        >
          <span className="sidebar-nav-icon">
            <IconSettingsGear4 size={16} />
          </span>
          <span className="sidebar-nav-label">Settings</span>
        </button>
      </footer>

      {menu ? (
        <NoteContextMenu
          noteId={menu.noteId}
          right={menu.right}
          top={menu.top}
          notes={notes}
          onOpenMoveDialog={onOpenMoveDialog}
          onRemoveNoteFromFolder={onRemoveNoteFromFolder}
          onDeleteNote={onDeleteNote}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </aside>
  );
}

function NoteRow({
  note,
  selected,
  recoverable,
  onSelect,
  onOpenMenu,
}: {
  note: NoteListItemDto;
  selected: boolean;
  recoverable: boolean;
  onSelect: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
}) {
  const title = note.title.trim() || "New note";
  const menuRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDragStart(event: DragEvent<HTMLElement>) {
    event.dataTransfer.effectAllowed = "link";
    event.dataTransfer.setData(NOTE_DND_MIME, note.id);
    event.dataTransfer.setData("text/plain", note.id);

    const node = event.currentTarget;
    const clone = node.cloneNode(true) as HTMLElement;
    clone.classList.add("note-row-drag-image");
    clone.removeAttribute("data-selected");
    clone.removeAttribute("data-dragging");
    clone.style.width = `${node.offsetWidth}px`;
    document.body.appendChild(clone);
    event.dataTransfer.setDragImage(clone, 16, 16);
    window.setTimeout(() => clone.remove(), 0);

    setDragging(true);
  }

  return (
    <article
      className="note-row"
      data-selected={selected}
      data-recoverable={recoverable || undefined}
      data-dragging={dragging || undefined}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => setDragging(false)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (menuRef.current) onOpenMenu(menuRef.current);
      }}
    >
      <div
        className="note-row-main"
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        <span className="note-row-icon">
          <IconNoteText size={15} />
        </span>
        <span className="note-row-title">
          <span className="note-row-title-text">{title}</span>
          {recoverable ? (
            <span
              className="note-row-recovery-dot"
              aria-label="Interrupted recording"
              title="Interrupted recording"
            />
          ) : null}
        </span>
      </div>
      <button
        ref={menuRef}
        type="button"
        className="note-row-menu"
        aria-label={`Actions for ${title}`}
        draggable={false}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenMenu(event.currentTarget);
        }}
      >
        <IconDotGrid1x3Vertical size={14} />
      </button>
    </article>
  );
}

function NoteContextMenu({
  noteId,
  right,
  top,
  notes,
  onOpenMoveDialog,
  onRemoveNoteFromFolder,
  onDeleteNote,
  onClose,
}: {
  noteId: string;
  right: number;
  top: number;
  notes: NoteListItemDto[];
  onOpenMoveDialog: (noteId: string) => void;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onClose: () => void;
}) {
  const note = notes.find((item) => item.id === noteId);
  const currentFolderId = note?.folderIds[0];
  const hasFolder = Boolean(currentFolderId);

  return (
    <div
      className="context-menu"
      style={{ right, top }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onOpenMoveDialog(noteId);
          onClose();
        }}
      >
        {hasFolder ? (
          <IconMoveFolder size={14} />
        ) : (
          <IconFolderAddRight size={14} />
        )}
        {hasFolder ? "Change folder" : "Add to folder"}
      </button>
      {hasFolder && currentFolderId ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onRemoveNoteFromFolder(noteId, currentFolderId);
            onClose();
          }}
        >
          <IconFolderDelete size={14} />
          Remove from folder
        </button>
      ) : null}
      <div className="context-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="destructive"
        onClick={() => {
          onDeleteNote(noteId);
          onClose();
        }}
      >
        <IconTrashCan size={14} />
        Delete note
      </button>
    </div>
  );
}
