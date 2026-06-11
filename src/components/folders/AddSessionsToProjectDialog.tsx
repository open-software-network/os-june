import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";
import type { FolderDto, HermesSessionInfo } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";

type AddSessionsToProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  folder: FolderDto;
  sessions: HermesSessionInfo[];
  /** sessionId -> project ids, used to hide sessions already in the project. */
  sessionFolderIds: Record<string, string[]>;
  /** Called once per session when the user commits the selection. */
  onAdd: (sessionId: string) => Promise<unknown> | void;
};

export function AddSessionsToProjectDialog({
  open,
  onClose,
  folder,
  sessions,
  sessionFolderIds,
  onAdd,
}: AddSessionsToProjectDialogProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(new Set());
    setSubmitting(false);
  }, [open]);

  const candidates = useMemo(() => {
    const available = sessions.filter(
      (session) => !(sessionFolderIds[session.id] ?? []).includes(folder.id),
    );
    const normalized = query.trim().toLowerCase();
    if (!normalized) return available;
    return available.filter((session) =>
      `${session.title ?? ""} ${session.preview ?? ""}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [sessions, sessionFolderIds, folder.id, query]);

  function toggle(sessionId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  async function handleSubmit() {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      // Commit serially so backend assigns are deterministic.
      for (const sessionId of selected) {
        await onAdd(sessionId);
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const count = selected.size;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (submitting) return;
        onClose();
      }}
      title={`Add sessions to ${folder.name}`}
      description="Pick the agent sessions you want in this project."
      initialFocusSelector='input[name="add-sessions-search"]'
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
            onClick={() => void handleSubmit()}
            disabled={submitting || count === 0}
          >
            {submitting
              ? "Adding…"
              : count === 0
                ? "Add sessions"
                : `Add ${count} ${count === 1 ? "session" : "sessions"}`}
          </button>
        </>
      }
    >
      <div className="add-notes-dialog">
        <label className="add-notes-search">
          <IconMagnifyingGlass size={14} />
          <input
            type="search"
            name="add-sessions-search"
            placeholder="Search sessions"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            autoComplete="off"
          />
        </label>
        {candidates.length > 0 ? (
          <ul className="add-notes-list" role="listbox" aria-multiselectable>
            {candidates.map((session) => {
              const isSelected = selected.has(session.id);
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="add-notes-row"
                    data-selected={isSelected}
                    onClick={() => toggle(session.id)}
                  >
                    <span className="add-notes-icon" aria-hidden>
                      <IconBubble3 size={14} />
                    </span>
                    <span className="add-notes-body">
                      <span className="add-notes-title">
                        {session.title?.trim() ||
                          session.preview?.trim() ||
                          "Untitled session"}
                      </span>
                      <span className="add-notes-preview">
                        {session.preview?.trim() || "No messages yet"}
                      </span>
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
            {sessions.some(
              (session) =>
                !(sessionFolderIds[session.id] ?? []).includes(folder.id),
            )
              ? "No sessions match that search."
              : "Every session already lives in this project."}
          </p>
        )}
      </div>
    </Dialog>
  );
}
