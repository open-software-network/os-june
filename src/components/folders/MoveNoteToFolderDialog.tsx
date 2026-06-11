import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";
import type { FolderDto, NoteListItemDto } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";

type Props = {
  open: boolean;
  onClose: () => void;
  notes: NoteListItemDto[];
  folders: FolderDto[];
  onSetFolder: (noteId: string, folderId: string) => Promise<unknown> | void;
  onMoved?: () => void;
};

export function MoveNoteToFolderDialog({
  open,
  onClose,
  notes,
  folders,
  onSetFolder,
  onMoved,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedId(null);
    setSubmitting(false);
  }, [open]);

  const isSingle = notes.length === 1;
  // The "currently in" exclusion only makes sense when every selected note
  // shares the same first folder; a mixed selection excludes nothing.
  const sharedFolderId =
    notes.length > 0 &&
    notes.every((note) => note.folderIds[0] === notes[0].folderIds[0])
      ? notes[0].folderIds[0]
      : undefined;
  const currentFolderId = sharedFolderId;
  const currentFolder = folders.find((f) => f.id === currentFolderId);
  const hasCurrent = isSingle && Boolean(currentFolder);

  const candidates = useMemo(() => {
    const available = folders.filter((folder) => folder.id !== currentFolderId);
    const normalized = query.trim().toLowerCase();
    const filtered = normalized
      ? available.filter((folder) =>
          `${folder.name} ${folder.description ?? ""}`
            .toLowerCase()
            .includes(normalized),
        )
      : available;
    return [...filtered].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [folders, currentFolderId, query]);

  async function handleCommit() {
    if (notes.length === 0 || !selectedId || submitting) return;
    setSubmitting(true);
    try {
      // Sequential awaits: handleSetNoteFolder dispatches optimistic state
      // updates per note, so we let each settle before the next.
      for (const note of notes) {
        await onSetFolder(note.id, selectedId);
      }
      onMoved?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const title = isSingle
    ? hasCurrent
      ? "Move meeting note"
      : "Add meeting note to project"
    : `Move ${notes.length} meeting notes`;
  const description = isSingle
    ? hasCurrent
      ? `This meeting note is in "${currentFolder?.name}". Pick another project to move it to.`
      : "Pick a project for this meeting note."
    : "Pick a project to move them to.";
  const commitLabel = isSingle && !hasCurrent ? "Add" : "Move";

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (submitting) return;
        onClose();
      }}
      title={title}
      description={description}
      initialFocusSelector='input[name="move-note-search"]'
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
            onClick={() => void handleCommit()}
            disabled={submitting || !selectedId}
          >
            {submitting ? `${commitLabel}ing…` : commitLabel}
          </button>
        </>
      }
    >
      <div className="move-note-dialog">
        <label className="add-notes-search">
          <IconMagnifyingGlass size={14} />
          <input
            type="search"
            name="move-note-search"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            autoComplete="off"
          />
        </label>
        {candidates.length > 0 ? (
          <ul className="add-notes-list" role="listbox">
            {candidates.map((folder) => {
              const isSelected = folder.id === selectedId;
              return (
                <li key={folder.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="add-notes-row"
                    data-selected={isSelected}
                    disabled={submitting}
                    onClick={() => setSelectedId(folder.id)}
                    onDoubleClick={() => void handleCommit()}
                  >
                    <span className="add-notes-icon" aria-hidden>
                      <IconFolder1 size={14} />
                    </span>
                    <span className="add-notes-body">
                      <span className="add-notes-title">{folder.name}</span>
                      {folder.description ? (
                        <span className="add-notes-preview">
                          {folder.description}
                        </span>
                      ) : null}
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
            {folders.length === 0
              ? "No projects yet. Create one from the Projects view."
              : query.trim()
                ? "No projects match that search."
                : "No other projects to move to."}
          </p>
        )}
      </div>
    </Dialog>
  );
}
