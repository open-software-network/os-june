import { IconDotGrid1x3Vertical } from "central-icons/IconDotGrid1x3Vertical";
import { IconFileText } from "central-icons/IconFileText";
import { IconFolders } from "central-icons/IconFolders";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophoneSparkle } from "central-icons/IconMicrophoneSparkle";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconSettingsGear1 } from "central-icons/IconSettingsGear1";
import { IconSidebarHiddenLeftWide } from "central-icons/IconSidebarHiddenLeftWide";
import { IconSidebarSimpleLeftWide } from "central-icons/IconSidebarSimpleLeftWide";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FolderDto, NoteListItemDto } from "../../lib/tauri";

export type SidebarView = "notes" | "dictation" | "settings" | "folders";

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
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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
  collapsed = false,
  onToggleCollapsed,
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
        {onToggleCollapsed ? (
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            onClick={onToggleCollapsed}
          >
            <span className="sidebar-toggle-icon" aria-hidden>
              <span data-active={collapsed}>
                <IconSidebarHiddenLeftWide size={18} />
              </span>
              <span data-active={!collapsed}>
                <IconSidebarSimpleLeftWide size={18} />
              </span>
            </span>
          </button>
        ) : null}
      </header>

      {collapsed ? (
        <button
          type="button"
          className="icon-button sidebar-search-collapsed"
          aria-label="Jump to"
          onClick={onToggleCollapsed}
        >
          <IconMagnifyingGlass size={16} />
        </button>
      ) : (
        <label className="sidebar-search">
          <IconMagnifyingGlass size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Jump to…"
          />
          <kbd className="sidebar-search-kbd" aria-hidden>
            ⌘K
          </kbd>
        </label>
      )}

      <nav className="sidebar-nav" aria-label="Primary">
        <button
          type="button"
          className="sidebar-nav-item"
          data-active={activeView === "settings"}
          aria-current={activeView === "settings" ? "page" : undefined}
          onClick={() => onChangeView("settings")}
        >
          <span className="sidebar-nav-icon">
            <IconSettingsGear1 size={16} />
          </span>
          <span className="sidebar-nav-label">Settings</span>
        </button>
        <button
          type="button"
          className="sidebar-nav-item"
          data-active={activeView === "dictation"}
          aria-current={activeView === "dictation" ? "page" : undefined}
          onClick={() => onChangeView("dictation")}
        >
          <span className="sidebar-nav-icon">
            <IconMicrophoneSparkle size={16} />
          </span>
          <span className="sidebar-nav-label">Dictation</span>
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
      </nav>

      <section
        className="sidebar-section"
        aria-label="Notes"
        data-active={activeView === "notes"}
      >
        <div className="section-title">
          <span className="section-title-label">
            Notes <span className="section-count">{filteredNotes.length}</span>
          </span>
          <button
            type="button"
            className="icon-button section-add"
            aria-label="New note"
            onClick={() => {
              onChangeView("notes");
              onCreateNote();
            }}
          >
            <IconPlusMedium size={14} />
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
            className="destructive"
            onClick={() => {
              onDeleteNote(menu.noteId);
              setMenu(null);
            }}
          >
            <IconTrashCan size={14} />
            Delete note
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function NoteRow({
  note,
  selected,
  onSelect,
  onOpenMenu,
}: {
  note: NoteListItemDto;
  selected: boolean;
  onSelect: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
}) {
  const title = note.title.trim() || "New note";
  const menuRef = useRef<HTMLButtonElement>(null);

  return (
    <article
      className="note-row"
      data-selected={selected}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (menuRef.current) onOpenMenu(menuRef.current);
      }}
    >
      <button type="button" className="note-row-main" onClick={onSelect}>
        <span className="note-row-icon">
          <IconFileText size={15} />
        </span>
        <span className="note-row-title">{title}</span>
      </button>
      <button
        ref={menuRef}
        type="button"
        className="note-row-menu"
        aria-label={`Actions for ${title}`}
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
