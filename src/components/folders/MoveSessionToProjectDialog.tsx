import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { IconProjects } from "central-icons/IconProjects";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";
import type { FolderDto, HermesSessionInfo } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";

type Props = {
  open: boolean;
  onClose: () => void;
  session: HermesSessionInfo | null;
  /** Project ids the session is currently filed under (first one wins). */
  currentFolderIds: string[];
  folders: FolderDto[];
  onSetFolder: (sessionId: string, folderId: string) => Promise<unknown> | void;
};

export function MoveSessionToProjectDialog({
  open,
  onClose,
  session,
  currentFolderIds,
  folders,
  onSetFolder,
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

  const currentFolderId = currentFolderIds[0];
  const currentFolder = folders.find((f) => f.id === currentFolderId);
  const hasCurrent = Boolean(currentFolder);

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
    if (!session || !selectedId || submitting) return;
    setSubmitting(true);
    try {
      await onSetFolder(session.id, selectedId);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const title = hasCurrent ? "Move session" : "Add session to project";
  const description = hasCurrent
    ? `This session is in "${currentFolder?.name}". Pick another project to move it to.`
    : "Pick a project for this session.";
  const commitLabel = hasCurrent ? "Move" : "Add";

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (submitting) return;
        onClose();
      }}
      title={title}
      description={description}
      initialFocusSelector='input[name="move-session-search"]'
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
            name="move-session-search"
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
                      <IconProjects size={14} />
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
