import { IconBubble3 } from "central-icons/IconBubble3";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useMemo, useState } from "react";
import {
  deleteHermesSession,
  sessionTimestamp,
} from "../../lib/hermes-adapter";
import { AGENT_DELETE_SESSION_EVENT } from "../../lib/agent-events";
import { messageFromError } from "../../lib/errors";
import type { FolderDto, HermesSessionInfo } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";

type AgentSessionsListProps = {
  sessions: HermesSessionInfo[];
  folders: FolderDto[];
  /** sessionId -> project (folder) ids the session is filed under. */
  sessionFolderIds: Record<string, string[]>;
  workingSessionIds?: ReadonlySet<string>;
  waitingSessionIds?: ReadonlySet<string>;
  onSelectSession: (session: HermesSessionInfo) => void;
  onNewSession: () => void;
  onOpenMoveDialog: (sessionId: string) => void;
  onRemoveFromProject: (sessionId: string, folderId: string) => void;
};

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

export function AgentSessionsList({
  sessions,
  folders,
  sessionFolderIds,
  workingSessionIds = EMPTY_SESSION_IDS,
  waitingSessionIds = EMPTY_SESSION_IDS,
  onSelectSession,
  onNewSession,
  onOpenMoveDialog,
  onRemoveFromProject,
}: AgentSessionsListProps) {
  const [query, setQuery] = useState("");
  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const sorted = [...sessions].sort((a, b) => {
      const statusDelta =
        sessionStatusPriority(b.id, workingSessionIds, waitingSessionIds) -
        sessionStatusPriority(a.id, workingSessionIds, waitingSessionIds);
      if (statusDelta !== 0) return statusDelta;
      return sessionTimestamp(b).localeCompare(sessionTimestamp(a));
    });
    if (!normalized) return sorted;
    return sorted.filter((session) =>
      `${session.title ?? ""} ${session.preview ?? ""} ${sessionStatusLabel(
        sessionStatus(session.id, workingSessionIds, waitingSessionIds),
      )}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [sessions, query, waitingSessionIds, workingSessionIds]);

  return (
    <section
      className="all-notes-workspace agent-sessions-workspace"
      aria-label="Agents"
    >
      <header className="folders-header">
        <div className="folders-heading">
          <h1>
            Agents
            {sessions.length > 0 ? (
              <span className="folders-count">{sessions.length}</span>
            ) : null}
          </h1>
          <p className="folders-subtitle">
            Every conversation with June across your workspace.
          </p>
        </div>
        <button
          type="button"
          className="primary-action primary-solid folders-create"
          onClick={onNewSession}
        >
          <IconPlusMedium size={13} />
          New session
        </button>
      </header>

      {sessions.length > 0 ? (
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

      {sessions.length === 0 ? (
        <div className="folders-empty">
          <p>No sessions yet.</p>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={onNewSession}
          >
            <IconPlusMedium size={13} />
            Start your first session
          </button>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="folders-empty">
          <p>No sessions match “{query.trim()}”.</p>
        </div>
      ) : (
        <ul className="folder-notes all-notes-list" role="list">
          {filteredSessions.map((session) => (
            <AgentSessionListRow
              key={session.id}
              session={session}
              projectName={projectNameFor(
                session.id,
                sessionFolderIds,
                folders,
              )}
              currentFolderId={sessionFolderIds[session.id]?.[0]}
              status={sessionStatus(
                session.id,
                workingSessionIds,
                waitingSessionIds,
              )}
              onSelect={() => onSelectSession(session)}
              onOpenMove={() => onOpenMoveDialog(session.id)}
              onRemoveFromProject={(folderId) =>
                onRemoveFromProject(session.id, folderId)
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function projectNameFor(
  sessionId: string,
  sessionFolderIds: Record<string, string[]>,
  folders: FolderDto[],
) {
  const folderId = sessionFolderIds[sessionId]?.[0];
  if (!folderId) return undefined;
  return folders.find((folder) => folder.id === folderId)?.name;
}

type AgentSessionListStatus = "running" | "waitingForUser" | undefined;

function sessionStatus(
  sessionId: string,
  workingSessionIds: ReadonlySet<string>,
  waitingSessionIds: ReadonlySet<string>,
): AgentSessionListStatus {
  if (waitingSessionIds.has(sessionId)) return "waitingForUser";
  if (workingSessionIds.has(sessionId)) return "running";
  return undefined;
}

function sessionStatusPriority(
  sessionId: string,
  workingSessionIds: ReadonlySet<string>,
  waitingSessionIds: ReadonlySet<string>,
) {
  if (waitingSessionIds.has(sessionId)) return 2;
  if (workingSessionIds.has(sessionId)) return 1;
  return 0;
}

function sessionStatusLabel(status: AgentSessionListStatus) {
  if (status === "waitingForUser") return "Needs you";
  if (status === "running") return "Working";
  return "";
}

function AgentSessionListRow({
  session,
  projectName,
  currentFolderId,
  status,
  onSelect,
  onOpenMove,
  onRemoveFromProject,
}: {
  session: HermesSessionInfo;
  projectName?: string;
  currentFolderId?: string;
  status?: AgentSessionListStatus;
  onSelect: () => void;
  onOpenMove: () => void;
  onRemoveFromProject: (folderId: string) => void;
}) {
  const title =
    session.title?.trim() || session.preview?.trim() || "Untitled session";
  const preview = session.preview?.trim() || "No messages yet";
  const statusLabel = sessionStatusLabel(status);
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteHermesSession(session.id);
      setDeleteError(null);
      // Lets the sidebar, menu bar, and App session state drop the row.
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
            detail: { sessionId: session.id },
          }),
        );
      }, 0);
    } catch (err) {
      setDeleteError(messageFromError(err));
      throw err;
    } finally {
      setDeleting(false);
    }
  }

  return (
    <li>
      <div
        className="folder-note-row all-notes-row"
        data-has-actions="true"
        data-menu-open={menu !== null}
        data-status={status}
      >
        <button type="button" className="folder-note-main" onClick={onSelect}>
          <span className="folder-note-icon" aria-hidden>
            <IconBubble3 size={15} />
          </span>
          <span className="folder-note-body">
            <span className="folder-note-title">{title}</span>
            <span className="folder-note-subtitle">
              {projectName ? `${projectName} · ${preview}` : preview}
            </span>
          </span>
        </button>
        {status ? (
          <span
            className="agent-session-list-status"
            data-status={status}
            role="status"
            aria-label={statusLabel}
          >
            <span aria-hidden />
            {statusLabel}
          </span>
        ) : (
          <span className="folder-note-time">
            {formatSessionTime(sessionTimestamp(session))}
          </span>
        )}
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
              {currentFolderId ? (
                <IconMoveFolder size={14} />
              ) : (
                <IconFolderAddRight size={14} />
              )}
              {currentFolderId ? "Change project" : "Add to project"}
            </button>
            {currentFolderId ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  onRemoveFromProject(currentFolderId);
                }}
              >
                <IconFolderDelete size={14} />
                Remove from project
              </button>
            ) : null}
            <div className="context-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="destructive"
              disabled={deleting}
              onClick={() => {
                setMenu(null);
                setConfirmDelete(true);
              }}
            >
              <IconTrashCan size={14} />
              Delete session
            </button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
        onConfirm={() => handleDelete()}
        title={`Delete "${title}"?`}
        description={deleteError || "This agent session cannot be restored."}
        confirmLabel="Delete session"
        destructive
      />
    </li>
  );
}

/** Same-day shows the time, within a week the weekday, older the date —
 * matches the note rows so the two lists read identically. */
function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return "";
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
