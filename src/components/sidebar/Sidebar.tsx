import { IconDotGrid1x3Vertical } from "central-icons/IconDotGrid1x3Vertical";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { BotIcon } from "lucide-react";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  markAgentNewSessionPending,
  type AgentSessionsChangedDetail,
} from "../agent/AgentWorkspace";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
} from "../../lib/agent-events";
import {
  deleteHermesSession,
  listHermesSessions,
  sessionTimestamp,
} from "../../lib/hermes-adapter";
import { NOTE_DND_MIME } from "../../lib/dnd";
import type { HermesSessionInfo, NoteListItemDto } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";

export type SidebarView =
  | "notes"
  | "meetings"
  | "all-notes"
  | "settings"
  | "folders"
  | "dictation"
  | "agent";

type SidebarProps = {
  notes: NoteListItemDto[];
  activeView: SidebarView;
  onChangeView: (view: SidebarView) => void;
  onSelectNote: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onOpenMoveDialog: (noteId: string) => void;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  onNewAgentSession: () => void;
  onSelectAgentSession: (session: HermesSessionInfo) => void;
  recoverableNoteIds?: ReadonlySet<string>;
  collapsed?: boolean;
};

type MenuState = {
  noteId: string;
  right: number;
  top: number;
};

const AGENT_SIDEBAR_SESSION_LIMIT = 12;

export function Sidebar({
  notes,
  activeView,
  onChangeView,
  onSelectNote,
  onDeleteNote,
  onOpenMoveDialog,
  onRemoveNoteFromFolder,
  onNewAgentSession,
  onSelectAgentSession,
  recoverableNoteIds,
  collapsed = false,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [agentSessions, setAgentSessions] = useState<HermesSessionInfo[]>([]);
  const [selectedAgentSessionId, setSelectedAgentSessionId] =
    useState<string>();
  const [agentSessionToDelete, setAgentSessionToDelete] =
    useState<HermesSessionInfo | null>(null);
  const [agentSessionDeleteError, setAgentSessionDeleteError] = useState<
    string | null
  >(null);
  const [deletingAgentSessionIds, setDeletingAgentSessionIds] = useState<
    Set<string>
  >(() => new Set());
  const [workingAgentSessionIds, setWorkingAgentSessionIds] = useState<
    Set<string>
  >(() => new Set());
  const [waitingAgentSessionIds, setWaitingAgentSessionIds] = useState<
    Set<string>
  >(() => new Set());
  const filteredNotes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return notes;
    return notes.filter((note) =>
      `${note.title} ${note.preview}`.toLowerCase().includes(normalized),
    );
  }, [notes, query]);

  const filteredAgentSessions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return agentSessions;
    return agentSessions.filter((session) =>
      `${session.title ?? ""} ${session.preview ?? ""}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [agentSessions, query]);

  function dispatchAgentEvent<T>(name: string, detail?: T) {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }, 0);
  }

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

  useEffect(() => {
    let cancelled = false;
    listHermesSessions({ limit: AGENT_SIDEBAR_SESSION_LIMIT })
      .then((sessions) => {
        if (!cancelled) {
          setAgentSessions((current) =>
            current.length > 0 ? current : sessions,
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgentSessions((current) => (current.length > 0 ? current : []));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleSessionsChanged(event: Event) {
      const detail = (event as CustomEvent<AgentSessionsChangedDetail>).detail;
      if (!detail) return;
      setAgentSessions(detail.sessions.slice(0, AGENT_SIDEBAR_SESSION_LIMIT));
      setSelectedAgentSessionId(detail.selectedSessionId);
      setWorkingAgentSessionIds(new Set(detail.workingSessionIds));
      setWaitingAgentSessionIds(new Set(detail.waitingSessionIds ?? []));
    }

    window.addEventListener(
      AGENT_SESSIONS_CHANGED_EVENT,
      handleSessionsChanged,
    );
    return () => {
      window.removeEventListener(
        AGENT_SESSIONS_CHANGED_EVENT,
        handleSessionsChanged,
      );
    };
  }, []);

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

  async function handleDeleteAgentSession(session: HermesSessionInfo) {
    setDeletingAgentSessionIds((current) => {
      const next = new Set(current);
      next.add(session.id);
      return next;
    });
    try {
      await deleteHermesSession(session.id);
      setAgentSessions((current) =>
        current.filter((item) => item.id !== session.id),
      );
      setSelectedAgentSessionId((current) =>
        current === session.id ? undefined : current,
      );
      setWorkingAgentSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
      dispatchAgentEvent(AGENT_DELETE_SESSION_EVENT, {
        sessionId: session.id,
      });
      setAgentSessionDeleteError(null);
    } catch (err) {
      setAgentSessionDeleteError(messageFromError(err));
      throw err;
    } finally {
      setDeletingAgentSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
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
            markAgentNewSessionPending();
            onNewAgentSession();
            dispatchAgentEvent(AGENT_NEW_SESSION_EVENT);
          }}
        >
          <span className="sidebar-nav-icon">
            <IconPlusMedium size={15} />
          </span>
          <span className="sidebar-nav-label">New Session</span>
        </button>
        <button
          type="button"
          className="sidebar-nav-item"
          data-active={activeView === "meetings" || activeView === "notes"}
          aria-current={
            activeView === "meetings" || activeView === "notes"
              ? "page"
              : undefined
          }
          onClick={() => {
            onChangeView("notes");
          }}
        >
          <span className="sidebar-nav-icon">
            <IconNoteText size={15} />
          </span>
          <span className="sidebar-nav-label">Notes</span>
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
        className="sidebar-section sidebar-agent-section"
        aria-label="Agent sessions"
        data-active={activeView === "agent"}
      >
        <div className="section-title section-title-with-action">
          <button
            type="button"
            className="section-title-label section-title-open"
            onClick={() => onChangeView("agent")}
          >
            Agent
          </button>
        </div>
        <div className="notes-nav-wrap">
          <div className="notes-nav">
            {filteredAgentSessions.length > 0 ? (
              filteredAgentSessions.map((session) => (
                <AgentSessionRow
                  key={session.id}
                  session={session}
                  selected={
                    activeView === "agent" &&
                    selectedAgentSessionId === session.id
                  }
                  working={workingAgentSessionIds.has(session.id)}
                  waiting={waitingAgentSessionIds.has(session.id)}
                  deleting={deletingAgentSessionIds.has(session.id)}
                  onSelect={() => {
                    setSelectedAgentSessionId(session.id);
                    onSelectAgentSession(session);
                  }}
                  onDelete={() => {
                    setAgentSessionDeleteError(null);
                    setAgentSessionToDelete(session);
                  }}
                />
              ))
            ) : (
              <div className="sidebar-empty">
                {agentSessions.length === 0 ? "No sessions yet" : "No matches"}
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
      <ConfirmDialog
        open={Boolean(agentSessionToDelete)}
        onClose={() => {
          setAgentSessionToDelete(null);
          setAgentSessionDeleteError(null);
        }}
        onConfirm={() =>
          agentSessionToDelete
            ? handleDeleteAgentSession(agentSessionToDelete)
            : undefined
        }
        title={`Delete "${
          agentSessionToDelete?.title ||
          agentSessionToDelete?.preview ||
          "Untitled session"
        }"?`}
        description={
          agentSessionDeleteError || "This agent session cannot be restored."
        }
        confirmLabel="Delete session"
        destructive
      />
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

function AgentSessionRow({
  session,
  selected,
  working,
  waiting,
  deleting,
  onSelect,
  onDelete,
}: {
  session: HermesSessionInfo;
  selected: boolean;
  working: boolean;
  waiting: boolean;
  deleting: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const title = session.title || session.preview || "Untitled session";
  const status = waiting ? "waitingForUser" : working ? "running" : undefined;
  return (
    <article className="note-row agent-sidebar-row" data-selected={selected}>
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
          <BotIcon size={15} />
        </span>
        <span className="note-row-title">
          <span className="note-row-title-text">{title}</span>
          {status ? (
            <span
              className="agent-sidebar-working"
              data-status={status}
              aria-label={status === "waitingForUser" ? "Needs you" : "Working"}
              title={status === "waitingForUser" ? "Needs you" : "Working"}
            />
          ) : null}
        </span>
      </div>
      <button
        type="button"
        className="note-row-menu agent-session-delete"
        aria-label="Delete session"
        title="Delete session"
        disabled={deleting}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDelete();
        }}
      >
        <IconTrashCan size={14} />
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

function relativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
