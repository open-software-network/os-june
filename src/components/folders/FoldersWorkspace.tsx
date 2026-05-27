import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFileText } from "central-icons/IconFileText";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";
import { IconFolderOpen } from "central-icons/IconFolderOpen";
import { IconPencil } from "central-icons/IconPencil";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconSortArrowUpDown } from "central-icons/IconSortArrowUpDown";
import { IconTrashCan } from "central-icons/IconTrashCan";
import {
  type DragEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NOTE_DND_MIME } from "../../lib/dnd";
import type { FolderDto, NoteListItemDto } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { AddNotesToFolderDialog } from "./AddNotesToFolderDialog";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { EditFolderDialog } from "./EditFolderDialog";

type FoldersWorkspaceProps = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  selectedFolderId?: string;
  onSelectFolder: (folderId?: string) => void;
  onCreateFolder: (
    name: string,
    description?: string,
  ) => Promise<FolderDto | undefined> | void;
  onRenameFolder: (
    folderId: string,
    name: string,
    description?: string,
  ) => void;
  onDeleteFolder: (
    folderId: string,
    deleteNotes: boolean,
  ) => Promise<unknown> | void;
  onCreateNote: (folderId?: string) => void;
  onSelectNote: (noteId: string) => void;
  onAssignNoteToFolder: (noteId: string, folderId: string) => Promise<unknown>;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  onOpenMoveDialog: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
};

export function FoldersWorkspace(props: FoldersWorkspaceProps) {
  const { folders, selectedFolderId } = props;
  const folder = useMemo(
    () => folders.find((item) => item.id === selectedFolderId),
    [folders, selectedFolderId],
  );

  if (selectedFolderId && folder) {
    return <FolderDetail {...props} folder={folder} />;
  }
  return <FolderList {...props} />;
}

/* List view -------------------------------------------------------- */

type SortKey = "updated" | "created" | "name" | "nameDesc";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Recent" },
  { value: "created", label: "Created" },
  { value: "name", label: "A to Z" },
  { value: "nameDesc", label: "Z to A" },
];

function FolderList({
  folders,
  notes,
  onSelectFolder,
  onCreateFolder,
  onDeleteFolder,
  onAssignNoteToFolder,
}: FoldersWorkspaceProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleteFolderTarget = folders.find((f) => f.id === deleteId);

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

  const sortedAndFiltered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = normalized
      ? folders.filter((folder) =>
          `${folder.name} ${folder.description ?? ""}`
            .toLowerCase()
            .includes(normalized),
        )
      : folders;
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          });
        case "nameDesc":
          return b.name.localeCompare(a.name, undefined, {
            sensitivity: "base",
          });
        case "created":
          return b.createdAt.localeCompare(a.createdAt);
        case "updated":
        default:
          return b.updatedAt.localeCompare(a.updatedAt);
      }
    });
  }, [folders, query, sort]);

  return (
    <section className="folders-workspace" aria-label="Folders">
      <header className="folders-header">
        <div className="folders-heading">
          <h1>Folders</h1>
          <p className="folders-subtitle">
            Group notes by project, client, or topic.
          </p>
        </div>
        <button
          type="button"
          className="primary-action primary-solid folders-create"
          onClick={() => setCreateOpen(true)}
        >
          <IconFolderAddRight size={14} />
          New folder
        </button>
      </header>

      {folders.length > 0 ? (
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
          <SortDropdown value={sort} onChange={setSort} />
        </div>
      ) : null}

      {folders.length === 0 ? (
        <div className="folders-empty">
          <p>No folders yet.</p>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => setCreateOpen(true)}
          >
            <IconFolderAddRight size={14} />
            Create your first folder
          </button>
        </div>
      ) : sortedAndFiltered.length === 0 ? (
        <div className="folders-empty">
          <p>No folders match “{query.trim()}”.</p>
        </div>
      ) : (
        <div className="folders-grid" role="list">
          {sortedAndFiltered.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              notes={notes}
              menuOpen={menu?.folderId === folder.id}
              onOpen={() => onSelectFolder(folder.id)}
              onDropNote={(noteId) => {
                const note = notes.find((item) => item.id === noteId);
                if (
                  !note ||
                  (note.folderIds.length === 1 &&
                    note.folderIds[0] === folder.id)
                ) {
                  return;
                }
                void onAssignNoteToFolder(noteId, folder.id);
              }}
              onOpenMenu={(anchor) => {
                if (menu?.folderId === folder.id) {
                  setMenu(null);
                  return;
                }
                const rect = anchor.getBoundingClientRect();
                setMenu({
                  folderId: folder.id,
                  right: window.innerWidth - rect.right,
                  top: rect.bottom + 4,
                });
              }}
            />
          ))}
        </div>
      )}

      {menu ? (
        <FolderCardMenu
          right={menu.right}
          top={menu.top}
          folderId={menu.folderId}
          folders={folders}
          notes={notes}
          onClose={() => setMenu(null)}
          onOpen={(folderId) => {
            onSelectFolder(folderId);
            setMenu(null);
          }}
          onRequestDelete={(folderId) => setDeleteId(folderId)}
        />
      ) : null}

      <ConfirmDialog
        open={deleteFolderTarget !== undefined}
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (!deleteFolderTarget) return;
          return onDeleteFolder(deleteFolderTarget.id, false);
        }}
        title={`Delete "${deleteFolderTarget?.name ?? ""}"?`}
        description="Notes inside this folder will stay in your library."
        confirmLabel="Delete folder"
        destructive
      />

      <CreateFolderDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (name, description) => {
          await onCreateFolder(name, description);
        }}
      />
    </section>
  );
}

function SortDropdown({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (value: SortKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = SORT_OPTIONS.find((option) => option.value === value);

  return (
    <div className="folders-sort" ref={ref}>
      <button
        type="button"
        className="folders-sort-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <IconSortArrowUpDown size={13} />
        <span>{current?.label ?? "Sort"}</span>
        <IconChevronDownSmall size={12} />
      </button>
      {open ? (
        <div className="folders-sort-menu" role="menu">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className="folders-sort-item"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="folders-sort-check" aria-hidden>
                {option.value === value ? <IconCheckmark1 size={11} /> : null}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type MenuState = { folderId: string; right: number; top: number };

function FolderCard({
  folder,
  notes,
  menuOpen,
  onOpen,
  onOpenMenu,
  onDropNote,
}: {
  folder: FolderDto;
  notes: NoteListItemDto[];
  menuOpen: boolean;
  onOpen: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
  onDropNote: (noteId: string) => void;
}) {
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const dragDepth = useRef(0);
  const [dropActive, setDropActive] = useState(false);
  const folderNotes = notes.filter((note) =>
    note.folderIds.includes(folder.id),
  );
  const lastUpdated = folderNotes[0]?.updatedAt ?? folder.updatedAt;

  function hasNoteData(event: DragEvent<HTMLElement>) {
    const types = event.dataTransfer.types;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === NOTE_DND_MIME) return true;
    }
    return false;
  }

  function resetDropState() {
    dragDepth.current = 0;
    setDropActive(false);
  }

  useEffect(() => {
    if (!dropActive) return;
    document.addEventListener("dragend", resetDropState);
    document.addEventListener("drop", resetDropState);
    return () => {
      document.removeEventListener("dragend", resetDropState);
      document.removeEventListener("drop", resetDropState);
    };
  }, [dropActive]);

  return (
    <article
      className="folder-card"
      data-menu-open={menuOpen}
      data-drop-active={dropActive || undefined}
      role="button"
      tabIndex={0}
      aria-label={`Open ${folder.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (menuButtonRef.current) onOpenMenu(menuButtonRef.current);
      }}
      onDragEnter={(event) => {
        if (!hasNoteData(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!hasNoteData(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "link";
      }}
      onDragLeave={(event) => {
        if (!hasNoteData(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) resetDropState();
      }}
      onDrop={(event) => {
        if (!hasNoteData(event)) return;
        event.preventDefault();
        const noteId = event.dataTransfer.getData(NOTE_DND_MIME);
        resetDropState();
        if (noteId) onDropNote(noteId);
      }}
    >
      <div className="folder-card-icon" aria-hidden>
        <IconFolder1 size={13} />
      </div>
      <div className="folder-card-body">
        <div className="folder-card-text">
          <h3 className="folder-card-title">{folder.name}</h3>
          {folder.description ? (
            <p className="folder-card-meta">{folder.description}</p>
          ) : null}
        </div>
        <p className="folder-card-footer">
          <span className="folder-card-footer-icon" aria-hidden>
            <IconFileText size={11} />
          </span>
          <span>
            {folderNotes.length} {folderNotes.length === 1 ? "note" : "notes"}
          </span>
          <span className="folder-card-footer-dot" aria-hidden>
            ·
          </span>
          <span>Updated {formatRelative(lastUpdated)}</span>
        </p>
      </div>
      <button
        ref={menuButtonRef}
        type="button"
        className="folder-card-menu"
        aria-label={`Actions for ${folder.name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenMenu(event.currentTarget);
        }}
      >
        <IconDotGrid1x3Horizontal size={14} />
      </button>
    </article>
  );
}

function FolderCardMenu({
  right,
  top,
  folderId,
  folders,
  onClose,
  onOpen,
  onRequestDelete,
}: {
  right: number;
  top: number;
  folderId: string;
  folders: FolderDto[];
  notes: NoteListItemDto[];
  onClose: () => void;
  onOpen: (folderId: string) => void;
  onRequestDelete: (folderId: string) => void;
}) {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return null;

  return (
    <div
      className="context-menu"
      style={{ right, top }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={() => onOpen(folder.id)}>
        <IconFolderOpen size={14} />
        Open
      </button>
      <button
        type="button"
        role="menuitem"
        className="destructive"
        onClick={() => {
          onClose();
          onRequestDelete(folder.id);
        }}
      >
        <IconTrashCan size={14} />
        Delete
      </button>
    </div>
  );
}

/* Detail view ------------------------------------------------------ */

function FolderDetail({
  folder,
  folders,
  notes,
  onSelectFolder,
  onRenameFolder,
  onDeleteFolder,
  onCreateNote,
  onSelectNote,
  onAssignNoteToFolder,
  onRemoveNoteFromFolder,
  onOpenMoveDialog,
  onDeleteNote,
}: FoldersWorkspaceProps & { folder: FolderDto }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(folder.name);
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (editingTitle && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(folder.name);
  }, [folder.name, editingTitle]);

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

  const folderNotes = useMemo(
    () =>
      notes
        .filter((note) => note.folderIds.includes(folder.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [notes, folder.id],
  );

  const lastUpdated = folderNotes[0]?.updatedAt ?? folder.updatedAt;

  function commitRename() {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === folder.name) {
      setTitleDraft(folder.name);
      return;
    }
    onRenameFolder(folder.id, next, folder.description ?? undefined);
  }

  function openMenu(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    setMenu({
      right: window.innerWidth - rect.right,
      top: rect.bottom + 4,
    });
  }

  return (
    <section className="folder-detail" aria-label={folder.name}>
      <div className="crumb-bar" data-tauri-drag-region>
        <button
          type="button"
          className="crumb-link"
          onClick={() => onSelectFolder(undefined)}
        >
          Folders
        </button>
        <span className="crumb-sep" aria-hidden>
          /
        </span>
        <span className="crumb-current">{folder.name}</span>
        <div className="crumb-actions">
          <button
            type="button"
            className="ghost-icon-button"
            aria-label={`Actions for ${folder.name}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              event.stopPropagation();
              if (menu) {
                setMenu(null);
                return;
              }
              openMenu(event.currentTarget);
            }}
          >
            <IconDotGrid1x3Horizontal size={14} />
          </button>
        </div>
      </div>

      <div className="folder-detail-content">
        <header className="folder-detail-header">
          {editingTitle ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                commitRename();
              }}
            >
              <input
                ref={titleRef}
                className="folder-detail-title-input"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.currentTarget.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setTitleDraft(folder.name);
                    setEditingTitle(false);
                  }
                }}
              />
            </form>
          ) : (
            <h1
              className="folder-detail-title"
              tabIndex={0}
              role="button"
              aria-label="Rename folder"
              onClick={() => setEditingTitle(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setEditingTitle(true);
                }
              }}
            >
              {folder.name}
            </h1>
          )}
          {folder.description ? (
            <p className="folder-detail-description">{folder.description}</p>
          ) : null}
          <p className="folder-detail-meta">
            <span className="folder-detail-meta-pill" aria-hidden>
              <IconFolder1 size={12} />
            </span>
            <span className="folder-detail-meta-dot" aria-hidden>
              ·
            </span>
            {folderNotes.length} {folderNotes.length === 1 ? "note" : "notes"}
            <span className="folder-detail-meta-dot" aria-hidden>
              ·
            </span>
            Updated {formatDate(lastUpdated)}
          </p>
        </header>

        {folderNotes.length > 0 ? (
          <FolderNotesPanel
            folder={folder}
            notes={folderNotes}
            hasNotesElsewhere={notes.some(
              (note) => !note.folderIds.includes(folder.id),
            )}
            onSelectNote={onSelectNote}
            onCreateNote={() => onCreateNote(folder.id)}
            onAddExisting={() => setAddOpen(true)}
            onOpenMoveDialog={onOpenMoveDialog}
            onRemoveNoteFromFolder={onRemoveNoteFromFolder}
            onDeleteNote={onDeleteNote}
          />
        ) : (
          <FolderEmptyState
            onCreateNote={() => onCreateNote(folder.id)}
            onAddExisting={() => setAddOpen(true)}
            hasNotesElsewhere={notes.some(
              (note) => !note.folderIds.includes(folder.id),
            )}
          />
        )}
      </div>

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
              setEditOpen(true);
            }}
          >
            <IconPencil size={14} />
            Edit details
          </button>
          <button
            type="button"
            role="menuitem"
            className="destructive"
            onClick={() => {
              setMenu(null);
              setDeleteOpen(true);
            }}
          >
            <IconTrashCan size={14} />
            Delete folder
          </button>
        </div>
      ) : null}

      <AddNotesToFolderDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        folder={folder}
        notes={notes}
        onAdd={async (noteId) => {
          await onAssignNoteToFolder(noteId, folder.id);
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => onDeleteFolder(folder.id, false)}
        title={`Delete "${folder.name}"?`}
        description="Notes inside this folder will stay in your library."
        confirmLabel="Delete folder"
        destructive
      />
      <EditFolderDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        folder={folder}
        onSave={(name, description) =>
          onRenameFolder(folder.id, name, description)
        }
      />
    </section>
  );
}

function FolderNotesPanel({
  folder,
  notes,
  hasNotesElsewhere,
  onSelectNote,
  onCreateNote,
  onAddExisting,
  onOpenMoveDialog,
  onRemoveNoteFromFolder,
  onDeleteNote,
}: {
  folder: FolderDto;
  notes: NoteListItemDto[];
  hasNotesElsewhere: boolean;
  onSelectNote: (noteId: string) => void;
  onCreateNote: () => void;
  onAddExisting: () => void;
  onOpenMoveDialog: (noteId: string) => void;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  onDeleteNote: (noteId: string) => void;
}) {
  return (
    <>
      <FolderActions
        onCreateNote={onCreateNote}
        onAddExisting={onAddExisting}
        hasNotesElsewhere={hasNotesElsewhere}
      />
      <ul className="folder-notes" role="list">
        {notes.map((note) => (
          <FolderNoteRow
            key={note.id}
            note={note}
            folder={folder}
            onSelect={() => onSelectNote(note.id)}
            onOpenMove={() => onOpenMoveDialog(note.id)}
            onRemoveFromFolder={() =>
              onRemoveNoteFromFolder(note.id, folder.id)
            }
            onDelete={() => onDeleteNote(note.id)}
          />
        ))}
      </ul>
    </>
  );
}

function FolderActions({
  onCreateNote,
  onAddExisting,
  hasNotesElsewhere,
}: {
  onCreateNote: () => void;
  onAddExisting: () => void;
  hasNotesElsewhere: boolean;
}) {
  return (
    <div className="folder-actions-row">
      {hasNotesElsewhere ? (
        <button
          type="button"
          className="primary-action"
          onClick={onAddExisting}
        >
          Add existing note
        </button>
      ) : null}
      <button
        type="button"
        className="primary-action primary-solid"
        onClick={onCreateNote}
      >
        <IconPlusMedium size={13} />
        New note
      </button>
    </div>
  );
}

function FolderNoteRow({
  note,
  folder: _folder,
  onSelect,
  onOpenMove,
  onRemoveFromFolder,
  onDelete,
}: {
  note: NoteListItemDto;
  folder: FolderDto;
  onSelect: () => void;
  onOpenMove: () => void;
  onRemoveFromFolder: () => void;
  onDelete: () => void;
}) {
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
      <div className="folder-note-row" data-menu-open={menu !== null}>
        <button type="button" className="folder-note-main" onClick={onSelect}>
          <span className="folder-note-icon" aria-hidden>
            <IconFileText size={14} />
          </span>
          <span className="folder-note-body">
            <span className="folder-note-title">
              {note.title.trim() || "New note"}
            </span>
            <span className="folder-note-subtitle">
              {note.preview.trim()
                ? note.preview
                : `Updated ${formatRelative(note.updatedAt)}`}
            </span>
          </span>
        </button>
        <span className="folder-note-time">
          {formatNoteTime(note.updatedAt)}
        </span>
        <button
          type="button"
          className="folder-note-menu"
          aria-label={`Actions for ${note.title.trim() || "this note"}`}
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
              <IconFolderAddRight size={14} />
              Move to folder
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onRemoveFromFolder();
              }}
            >
              <IconFolderDelete size={14} />
              Remove from folder
            </button>
            <div className="context-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="destructive"
              onClick={() => {
                setMenu(null);
                if (
                  window.confirm(
                    `Delete "${
                      note.title.trim() || "New note"
                    }"? This cannot be undone.`,
                  )
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

function FolderEmptyState({
  onCreateNote,
  onAddExisting,
  hasNotesElsewhere,
}: {
  onCreateNote: () => void;
  onAddExisting: () => void;
  hasNotesElsewhere: boolean;
}) {
  return (
    <div className="folder-empty-surface" role="group">
      <p className="folder-empty-hint">
        Capture a meeting, a phone call, or a half-formed thought
      </p>
      <div className="folder-empty-actions">
        {hasNotesElsewhere ? (
          <button
            type="button"
            className="primary-action"
            onClick={onAddExisting}
          >
            Add existing note
          </button>
        ) : null}
        <button
          type="button"
          className="primary-action primary-solid"
          onClick={onCreateNote}
        >
          <IconPlusMedium size={13} />
          New note
        </button>
      </div>
    </div>
  );
}

/* Formatting helpers ----------------------------------------------- */

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/** Right-aligned timestamp inside a folder's note row. Same-day shows
 * just the time ("2:09 PM"). Within a week, the weekday ("Mon"). Older,
 * the date ("May 22"). */
function formatNoteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
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
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
