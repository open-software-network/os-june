import { IconCheckmark2Medium } from "central-icons-filled/IconCheckmark2Medium";
import { IconArrowUndoUp } from "central-icons/IconArrowUndoUp";
import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconPencil } from "central-icons/IconPencil";
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
import {
  deleteHermesSession,
  isScheduledRunSession,
  sessionTimestamp,
} from "../../lib/hermes-adapter";
import { AGENT_DELETE_SESSION_EVENT } from "../../lib/agent-events";
import { messageFromError } from "../../lib/errors";
import { useForcedEmptyStates } from "../../lib/empty-states-demo";
import { primaryShortcutLabel } from "../../lib/platform";
import type { FolderDto, HermesSessionInfo } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { RenameSessionDialog } from "./RenameSessionDialog";

type AgentSessionsListProps = {
  sessions: HermesSessionInfo[];
  folders: FolderDto[];
  /** sessionId -> project (folder) ids the session is filed under. */
  sessionFolderIds: Record<string, string[]>;
  workingSessionIds?: ReadonlySet<string>;
  waitingSessionIds?: ReadonlySet<string>;
  /** stored session id -> completed_at ISO. Completed sessions move to a
   * collapsible Completed group instead of the active list. */
  completedSessionIds?: Record<string, string>;
  onToggleCompleted?: (sessionId: string, completed: boolean) => void;
  onSelectSession: (session: HermesSessionInfo) => void;
  onNewSession: () => void;
  /** stored session id (not the runtime session id). */
  onRenameSession: (sessionId: string, title: string) => void;
  onOpenMoveDialog: (sessionId: string) => void;
  onOpenMoveSessions: (sessionIds: string[]) => void;
  onRemoveFromProject: (sessionId: string, folderId: string) => void;
};

export type AgentSessionsListHandle = {
  resetSelection: () => void;
};

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();
const NO_SESSIONS: HermesSessionInfo[] = [];
const EMPTY_COMPLETED: Record<string, string> = {};

export const AgentSessionsList = forwardRef<AgentSessionsListHandle, AgentSessionsListProps>(
  function AgentSessionsList(
    {
      sessions: allSessions,
      folders,
      sessionFolderIds,
      workingSessionIds = EMPTY_SESSION_IDS,
      waitingSessionIds = EMPTY_SESSION_IDS,
      completedSessionIds = EMPTY_COMPLETED,
      onToggleCompleted,
      onSelectSession,
      onNewSession,
      onRenameSession,
      onOpenMoveDialog,
      onOpenMoveSessions,
      onRemoveFromProject,
    },
    ref,
  ) {
    // __emptyStates() preview (dev console): render the page as a fresh
    // install would see it, real data untouched underneath.
    const sessions = useForcedEmptyStates() ? NO_SESSIONS : allSessions;
    const [query, setQuery] = useState("");
    const newSessionShortcut = primaryShortcutLabel("N");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
    const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
    const [completedCollapsed, setCompletedCollapsed] = useState(true);
    const [exit, setExit] = useState<null | "slide" | "fade">(null);
    const exitCauseRef = useRef<"slide" | "fade">("fade");

    const sortedSessions = useMemo(
      () =>
        [...sessions].sort((a, b) => {
          const statusDelta =
            sessionStatusPriority(b.id, workingSessionIds, waitingSessionIds) -
            sessionStatusPriority(a.id, workingSessionIds, waitingSessionIds);
          if (statusDelta !== 0) return statusDelta;
          return sessionTimestamp(b).localeCompare(sessionTimestamp(a));
        }),
      [sessions, waitingSessionIds, workingSessionIds],
    );
    const filteredSessions = useMemo(() => {
      const normalized = query.trim().toLowerCase();
      if (!normalized) return sortedSessions;
      return sortedSessions.filter((session) =>
        `${session.title ?? ""} ${session.preview ?? ""} ${sessionStatusLabel(
          sessionStatus(session.id, workingSessionIds, waitingSessionIds),
        )}`
          .toLowerCase()
          .includes(normalized),
      );
    }, [sortedSessions, query, waitingSessionIds, workingSessionIds]);
    const activeSessions = filteredSessions.filter((session) => !completedSessionIds[session.id]);
    const completedSessions = filteredSessions
      .filter((session) => Boolean(completedSessionIds[session.id]))
      .sort((a, b) =>
        (completedSessionIds[b.id] ?? "").localeCompare(completedSessionIds[a.id] ?? ""),
      );
    const selectedSessionIds = useMemo(
      () =>
        sortedSessions
          .filter((session) => selectedIds.has(session.id))
          .map((session) => session.id),
      [sortedSessions, selectedIds],
    );
    const visibleSelectedCount = activeSessions.filter((session) =>
      selectedIds.has(session.id),
    ).length;
    const selectedCount = selectedSessionIds.length;
    const hasUnselectedVisibleSessions =
      activeSessions.length > 0 && visibleSelectedCount < activeSessions.length;

    const lastCountRef = useRef(selectedCount);
    if (selectedCount > 0) lastCountRef.current = selectedCount;
    const displayCount = selectedCount > 0 ? selectedCount : lastCountRef.current;

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
      const sessionIds = new Set(sessions.map((session) => session.id));
      setSelectedIds((previous) => {
        const next = new Set([...previous].filter((id) => sessionIds.has(id)));
        return next.size === previous.size ? previous : next;
      });
      if (sessions.length === 0) {
        setConfirmBulkDelete(false);
        setBulkDeleteError(null);
      }
    }, [sessions]);

    function toggleSelected(sessionId: string) {
      setSelectedIds((previous) => {
        const next = new Set(previous);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
    }

    const resetSelection = useCallback(() => {
      exitCauseRef.current = "slide";
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
      setBulkDeleteError(null);
    }, []);

    useImperativeHandle(ref, () => ({ resetSelection }), [resetSelection]);

    function selectAllVisibleSessions() {
      setSelectedIds((previous) => {
        const next = new Set(previous);
        for (const session of activeSessions) {
          next.add(session.id);
        }
        return next;
      });
    }

    function deselectAllVisibleSessions() {
      setSelectedIds((previous) => {
        const next = new Set(previous);
        for (const session of activeSessions) {
          next.delete(session.id);
        }
        return next;
      });
    }

    useEffect(() => {
      if (selectedCount === 0 || confirmBulkDelete) return;
      function onKey(event: KeyboardEvent) {
        const target = event.target instanceof Element ? event.target : null;
        if (event.key === "Escape" && !target?.closest('[role="dialog"]')) resetSelection();
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [selectedCount, confirmBulkDelete, resetSelection]);

    async function handleBulkDelete() {
      try {
        for (const sessionId of selectedSessionIds) {
          await deleteHermesSession(sessionId);
          window.setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
                detail: { sessionId },
              }),
            );
          }, 0);
        }
        resetSelection();
      } catch (err) {
        setBulkDeleteError(messageFromError(err));
        throw err;
      }
    }

    return (
      <section className="all-notes-workspace agent-sessions-workspace" aria-label="Sessions">
        <header className="folders-header">
          <div className="folders-heading">
            <h1>
              Sessions
              {sessions.length > 0 ? (
                <span className="folders-count">{sessions.length}</span>
              ) : null}
            </h1>
          </div>
          <button
            type="button"
            className="primary-action primary-solid folders-create"
            onClick={onNewSession}
          >
            <IconPlusMedium size={13} />
            New session
            <kbd className="primary-action-kbd" aria-hidden>
              {newSessionShortcut}
            </kbd>
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
          <EmptyState
            label="Start your first session"
            icon={<IconBubble3 size={28} />}
            title="Put June to work"
            description="Ask June to check on your computer, dig through your files, or research a topic. Each session keeps one task's conversation and everything it produces in one place."
            action={
              <button type="button" className="primary-action primary-solid" onClick={onNewSession}>
                <IconPlusMedium size={13} />
                Start your first session
              </button>
            }
          />
        ) : activeSessions.length === 0 && completedSessions.length === 0 ? (
          <div className="folders-empty">
            <p>No sessions match “{query.trim()}”.</p>
          </div>
        ) : (
          <>
            {activeSessions.length > 0 ? (
              <ul
                className="folder-notes all-notes-list"
                role="list"
                data-selecting={selectedCount > 0}
              >
                {activeSessions.map((session) => (
                  <AgentSessionListRow
                    key={session.id}
                    session={session}
                    projectName={projectNameFor(session.id, sessionFolderIds, folders)}
                    currentFolderId={sessionFolderIds[session.id]?.[0]}
                    status={sessionStatus(session.id, workingSessionIds, waitingSessionIds)}
                    checked={selectedIds.has(session.id)}
                    completed={false}
                    onToggleCompleted={
                      onToggleCompleted ? () => onToggleCompleted(session.id, true) : undefined
                    }
                    onToggleSelected={() => toggleSelected(session.id)}
                    onSelect={() => onSelectSession(session)}
                    onRename={(title) => onRenameSession(session.id, title)}
                    onOpenMove={() => onOpenMoveDialog(session.id)}
                    onRemoveFromProject={(folderId) => onRemoveFromProject(session.id, folderId)}
                  />
                ))}
              </ul>
            ) : null}

            {completedSessions.length > 0 ? (
              <section className="agent-sessions-completed" aria-label="Completed sessions">
                <button
                  type="button"
                  className="agent-sessions-completed-toggle"
                  aria-expanded={!completedCollapsed}
                  onClick={() => setCompletedCollapsed((v) => !v)}
                >
                  Completed
                  <span className="folders-count">{completedSessions.length}</span>
                </button>
                {completedCollapsed ? null : (
                  <ul className="folder-notes all-notes-list" role="list">
                    {completedSessions.map((session) => (
                      <AgentSessionListRow
                        key={session.id}
                        session={session}
                        projectName={projectNameFor(session.id, sessionFolderIds, folders)}
                        currentFolderId={sessionFolderIds[session.id]?.[0]}
                        status={sessionStatus(session.id, workingSessionIds, waitingSessionIds)}
                        checked={selectedIds.has(session.id)}
                        completed
                        onToggleCompleted={
                          onToggleCompleted ? () => onToggleCompleted(session.id, false) : undefined
                        }
                        onToggleSelected={() => toggleSelected(session.id)}
                        onSelect={() => onSelectSession(session)}
                        onRename={(title) => onRenameSession(session.id, title)}
                        onOpenMove={() => onOpenMoveDialog(session.id)}
                        onRemoveFromProject={(folderId) =>
                          onRemoveFromProject(session.id, folderId)
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
          </>
        )}

        {barMounted ? (
          <div
            className="meetings-bulk-bar"
            role="toolbar"
            aria-label="Selection"
            data-exit={isExiting ? exit : undefined}
            onAnimationEnd={(event) => {
              if (!isExiting || event.target !== event.currentTarget) return;
              if (event.animationName && !event.animationName.startsWith("meetings-bulk-bar-out")) {
                return;
              }
              setExit(null);
            }}
          >
            <span className="meetings-bulk-count">{displayCount} selected</span>
            {hasUnselectedVisibleSessions ? (
              <button
                type="button"
                className="meetings-bulk-action"
                onClick={selectAllVisibleSessions}
                disabled={isExiting}
              >
                Select all
              </button>
            ) : null}
            <button
              type="button"
              className="meetings-bulk-action"
              onClick={deselectAllVisibleSessions}
              disabled={isExiting}
            >
              Deselect all
            </button>
            <button
              type="button"
              className="meetings-bulk-action"
              onClick={() => onOpenMoveSessions(selectedSessionIds)}
              disabled={isExiting}
            >
              Move
            </button>
            <button
              type="button"
              className="meetings-bulk-action"
              onClick={() => setConfirmBulkDelete(true)}
              disabled={isExiting}
            >
              Delete
            </button>
            <button
              type="button"
              className="meetings-bulk-dismiss"
              aria-label="Clear selection"
              onClick={resetSelection}
              disabled={isExiting}
            >
              <IconCrossMedium size={14} />
            </button>
          </div>
        ) : null}

        <ConfirmDialog
          open={confirmBulkDelete}
          onClose={() => {
            setConfirmBulkDelete(false);
            setBulkDeleteError(null);
          }}
          onConfirm={() => handleBulkDelete()}
          title={`Delete ${selectedCount} ${selectedCount === 1 ? "session" : "sessions"}?`}
          description={
            bulkDeleteError || "This cannot be undone. These agent sessions will be removed."
          }
          confirmLabel={selectedCount === 1 ? "Delete session" : "Delete sessions"}
          destructive
        />
      </section>
    );
  },
);

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
  checked,
  completed,
  onToggleCompleted,
  onToggleSelected,
  onSelect,
  onRename,
  onOpenMove,
  onRemoveFromProject,
}: {
  session: HermesSessionInfo;
  projectName?: string;
  currentFolderId?: string;
  status?: AgentSessionListStatus;
  checked: boolean;
  completed?: boolean;
  onToggleCompleted?: () => void;
  onToggleSelected: () => void;
  onSelect: () => void;
  onRename: (title: string) => void;
  onOpenMove: () => void;
  onRemoveFromProject: (folderId: string) => void;
}) {
  const title = session.title?.trim() || session.preview?.trim() || "Untitled session";
  const preview = session.preview?.trim() || "No messages yet";
  const statusLabel = sessionStatusLabel(status);
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);

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

  const rowMain = (
    <>
      <span className="folder-note-icon" aria-hidden>
        {isScheduledRunSession(session) ? (
          <IconArrowsRepeat size={15} />
        ) : (
          <IconBubble3 size={15} />
        )}
      </span>
      <span className="folder-note-body">
        <span className="folder-note-title">{title}</span>
        <span className="folder-note-subtitle">
          {projectName ? `${projectName} · ${preview}` : preview}
        </span>
      </span>
    </>
  );

  return (
    <li>
      <div
        className="folder-note-row all-notes-row agent-session-row"
        data-selected={checked}
        data-has-actions="true"
        data-menu-open={menu !== null}
        data-status={status}
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
          {rowMain}
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
          <span className="folder-note-time">{formatSessionTime(sessionTimestamp(session))}</span>
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
                setRenameDialogOpen(true);
              }}
            >
              <IconPencil size={14} />
              Rename
            </button>
            {onToggleCompleted ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  onToggleCompleted();
                }}
              >
                {completed ? <IconArrowUndoUp size={14} /> : <IconCircleCheck size={14} />}
                {completed ? "Mark as active" : "Mark as complete"}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onOpenMove();
              }}
            >
              {currentFolderId ? <IconMoveFolder size={14} /> : <IconFolderAddRight size={14} />}
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
      <RenameSessionDialog
        open={renameDialogOpen}
        currentName={title}
        onClose={() => setRenameDialogOpen(false)}
        onRename={onRename}
      />
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
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
