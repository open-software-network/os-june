import { IconArrowBoxRight } from "central-icons/IconArrowBoxRight";
import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconAudio } from "central-icons/IconAudio";
import { IconBrain2 } from "central-icons/IconBrain2";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCreditCard1 } from "central-icons/IconCreditCard1";
import { IconDotGrid1x3Vertical } from "central-icons/IconDotGrid1x3Vertical";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconMicrophoneSparkle } from "central-icons/IconMicrophoneSparkle";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPeople } from "central-icons/IconPeople";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconProjects } from "central-icons/IconProjects";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconShortcut } from "central-icons/IconShortcut";
import { IconTrashCan } from "central-icons/IconTrashCan";
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  markAgentNewSessionPending,
  type AgentSessionsChangedDetail,
} from "../agent/AgentWorkspace";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  emitAgentSessionsChanged,
} from "../../lib/agent-events";
import {
  deleteHermesSession,
  listHermesSessions,
  sessionTimestamp,
} from "../../lib/hermes-adapter";
import { messageFromError } from "../../lib/errors";
import { NOTE_DND_MIME } from "../../lib/dnd";
import type {
  AccountStatus,
  HermesSessionInfo,
  NoteListItemDto,
} from "../../lib/tauri";
import { type SettingsTab } from "../settings/AppSettings";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { DotSpinner } from "../DotSpinner";
import { IconPangolin } from "../icons/IconPangolin";

export type SidebarView =
  | "notes"
  | "meetings"
  | "all-notes"
  | "settings"
  | "folders"
  | "dictation"
  | "routines"
  | "agent"
  | "agent-sessions";

type SidebarProps = {
  notes: NoteListItemDto[];
  activeView: SidebarView;
  // Settings is its own page reached from the user's name; these default so
  // tests that mount the sidebar for non-settings views can skip the plumbing.
  account?: AccountStatus;
  settingsTab?: SettingsTab;
  onSettingsTabChange?: (tab: SettingsTab) => void;
  onChangeView: (view: SidebarView) => void;
  // Returns to wherever the user was before opening settings (falls back to
  // Notes when not wired, e.g. unit tests).
  onExitSettings?: () => void;
  onSignOut?: () => void;
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

type CommandPaletteItem = {
  id: string;
  label: string;
  meta?: string;
  icon: ReactNode;
  searchText: string;
  action: () => void;
};

type CommandPaletteGroup = {
  title: string;
  items: CommandPaletteItem[];
};

const AGENT_SIDEBAR_SESSION_LIMIT = 12;
const AGENT_SIDEBAR_SESSION_RETRY_DELAYS_MS = [
  250, 500, 1000, 2000, 4000, 8000, 16000, 32000,
];

const SETTINGS_SIDEBAR_GROUPS: {
  title: string;
  items: { id: SettingsTab; label: string; icon: ReactNode }[];
}[] = [
  {
    title: "Personal",
    items: [
      {
        id: "general",
        label: "General",
        icon: <IconSettingsGear4 size={16} />,
      },
      {
        id: "billing",
        label: "Billing",
        icon: <IconCreditCard1 size={16} />,
      },
      {
        id: "shortcuts",
        label: "Shortcuts",
        icon: <IconShortcut size={16} />,
      },
    ],
  },
  {
    title: "Audio",
    items: [
      {
        id: "dictation",
        label: "Dictation",
        icon: <IconMicrophoneSparkle size={16} />,
      },
      { id: "audio", label: "Audio", icon: <IconAudio size={16} /> },
    ],
  },
  {
    title: "AI",
    items: [
      { id: "models", label: "Models", icon: <IconBrain2 size={16} /> },
      { id: "agent", label: "Agent", icon: <IconPangolin size={16} /> },
    ],
  },
  {
    title: "App",
    items: [
      { id: "about", label: "About", icon: <IconCircleInfo size={16} /> },
    ],
  },
];

export function Sidebar({
  notes,
  activeView,
  account = { signedIn: false, configured: false },
  settingsTab = "general",
  onSettingsTabChange,
  onChangeView,
  onExitSettings,
  onSignOut,
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
  const commandInputRef = useRef<HTMLInputElement>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [identityMenuOpen, setIdentityMenuOpen] = useState(false);
  const inSettings = activeView === "settings";
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
  // Sessions that finished a turn while the user wasn't looking — shown as a
  // terracotta dot in place of the timestamp until the session is opened.
  const [unreadAgentSessionIds, setUnreadAgentSessionIds] = useState<
    Set<string>
  >(() => new Set());
  // Refs for the mount-once sessions-changed listener: the previous working
  // set (to spot sessions that just finished) and which session is open in
  // front of the user (those never go unread).
  const workingAgentSessionIdsRef = useRef<Set<string>>(new Set());
  const openAgentSessionIdRef = useRef<string | undefined>(undefined);

  // formatSessionTime reads the clock at render time, so re-render once a
  // minute to keep the relative timestamps ("5m", "3h") advancing instead of
  // waiting for an unrelated session event.
  const [, bumpTimeClock] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(
      () => bumpTimeClock((tick) => tick + 1),
      60_000,
    );
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const openId = activeView === "agent" ? selectedAgentSessionId : undefined;
    openAgentSessionIdRef.current = openId;
    if (!openId) return;
    // Opening a session reads it.
    setUnreadAgentSessionIds((current) => {
      if (!current.has(openId)) return current;
      const next = new Set(current);
      next.delete(openId);
      return next;
    });
  }, [activeView, selectedAgentSessionId]);
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

  const commandPaletteGroups = useMemo<CommandPaletteGroup[]>(() => {
    const normalized = normalizeCommandQuery(commandQuery);
    const matches = (item: CommandPaletteItem) =>
      !normalized || item.searchText.includes(normalized);

    const recentItems: CommandPaletteItem[] = [
      ...notes.slice(0, 5).map((note) => {
        const title = note.title.trim() || "New meeting";
        return {
          id: `note:${note.id}`,
          label: title,
          meta: "Meeting",
          icon: <IconNoteText size={15} />,
          searchText: normalizeCommandQuery(`${title} ${note.preview}`),
          action: () => onSelectNote(note.id),
        };
      }),
      ...agentSessions.slice(0, 5).map((session) => {
        const title =
          session.title?.trim() || session.preview?.trim() || "Untitled";
        return {
          id: `agent:${session.id}`,
          label: title,
          meta: "Agent",
          icon: <IconPangolin size={15} />,
          searchText: normalizeCommandQuery(
            `${title} ${session.preview ?? ""} agent session`,
          ),
          action: () => {
            setSelectedAgentSessionId(session.id);
            onSelectAgentSession(session);
          },
        };
      }),
    ]
      .filter(matches)
      .slice(0, 6);

    const quickItems: CommandPaletteItem[] = [
      {
        id: "quick:new-session",
        label: "New session",
        icon: <IconPlusMedium size={15} />,
        searchText: normalizeCommandQuery("new session agent"),
        action: handleNewAgentSession,
      },
      {
        id: "quick:meetings",
        label: "Go to Meetings",
        icon: <IconNoteText size={15} />,
        searchText: normalizeCommandQuery("meetings notes go to"),
        action: () => onChangeView("notes"),
      },
      {
        id: "quick:projects",
        label: "Go to Projects",
        icon: <IconProjects size={15} />,
        searchText: normalizeCommandQuery("projects folders go to"),
        action: () => onChangeView("folders"),
      },
      {
        id: "quick:dictation",
        label: "Go to Dictation",
        icon: <IconMicrophone size={15} />,
        searchText: normalizeCommandQuery("dictation go to"),
        action: () => onChangeView("dictation"),
      },
      {
        id: "quick:routines",
        label: "Go to Routines",
        icon: <IconArrowsRepeat size={15} />,
        searchText: normalizeCommandQuery("routines go to"),
        action: () => onChangeView("routines"),
      },
      {
        id: "quick:settings-general",
        label: "Settings -> General",
        icon: <IconSettingsGear4 size={15} />,
        searchText: normalizeCommandQuery("settings general"),
        action: () => {
          onSettingsTabChange?.("general");
          onChangeView("settings");
        },
      },
    ].filter(matches);

    return [
      { title: "Recents", items: recentItems },
      { title: "Quick actions", items: quickItems },
    ].filter((group) => group.items.length > 0);
  }, [
    agentSessions,
    commandQuery,
    notes,
    onChangeView,
    onSelectAgentSession,
    onSelectNote,
    onSettingsTabChange,
  ]);

  const commandPaletteItems = commandPaletteGroups.flatMap(
    (group) => group.items,
  );

  useEffect(() => {
    setCommandActiveIndex(0);
  }, [commandPaletteOpen, commandQuery]);

  useEffect(() => {
    if (commandActiveIndex < commandPaletteItems.length) return;
    setCommandActiveIndex(Math.max(commandPaletteItems.length - 1, 0));
  }, [commandActiveIndex, commandPaletteItems.length]);

  function dispatchAgentEvent<T>(name: string, detail?: T) {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }, 0);
  }

  function handleNewAgentSession() {
    markAgentNewSessionPending();
    onNewAgentSession();
    dispatchAgentEvent(AGENT_NEW_SESSION_EVENT);
  }

  function openCommandPalette() {
    setMenu(null);
    setIdentityMenuOpen(false);
    setCommandQuery("");
    setCommandActiveIndex(0);
    setCommandPaletteOpen(true);
  }

  function closeCommandPalette() {
    setCommandPaletteOpen(false);
  }

  function runCommandPaletteItem(item: CommandPaletteItem) {
    closeCommandPalette();
    item.action();
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
    function onKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      openCommandPalette();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!commandPaletteOpen) return;
    const frame = window.requestAnimationFrame(() => {
      commandInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [commandPaletteOpen]);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: number | undefined;

    function loadAgentSessions(attempt: number) {
      listHermesSessions({ limit: AGENT_SIDEBAR_SESSION_LIMIT })
        .then((sessions) => {
          if (!cancelled) {
            setAgentSessions((current) =>
              current.length > 0 ? current : sessions,
            );
            if (sessions.length > 0) {
              emitAgentSessionsChanged({
                sessions,
                workingSessionIds: [],
                waitingSessionIds: [],
              });
            }
          }
        })
        .catch(() => {
          if (cancelled) return;
          const retryDelay = AGENT_SIDEBAR_SESSION_RETRY_DELAYS_MS[attempt];
          if (retryDelay != null) {
            retryTimeout = window.setTimeout(
              () => loadAgentSessions(attempt + 1),
              retryDelay,
            );
            return;
          }
          setAgentSessions((current) => (current.length > 0 ? current : []));
        });
    }

    loadAgentSessions(0);

    return () => {
      cancelled = true;
      if (retryTimeout != null) {
        window.clearTimeout(retryTimeout);
      }
    };
  }, []);

  useEffect(() => {
    function handleSessionsChanged(event: Event) {
      const detail = (event as CustomEvent<AgentSessionsChangedDetail>).detail;
      if (!detail) return;
      setAgentSessions(detail.sessions.slice(0, AGENT_SIDEBAR_SESSION_LIMIT));
      setSelectedAgentSessionId(detail.selectedSessionId);
      const nextWorking = new Set(detail.workingSessionIds);
      const nextWaiting = new Set(detail.waitingSessionIds ?? []);
      // A session that left the working set without pausing for input just
      // finished a turn — mark it unread unless it's open in front of the
      // user.
      const openId = openAgentSessionIdRef.current;
      const finished = Array.from(workingAgentSessionIdsRef.current).filter(
        (id) => !nextWorking.has(id) && !nextWaiting.has(id) && id !== openId,
      );
      workingAgentSessionIdsRef.current = nextWorking;
      setUnreadAgentSessionIds((current) => {
        let changed = false;
        const next = new Set(current);
        for (const id of finished) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        // A session that starts a new turn (or pauses for input) before the
        // user opened it drops its unread mark — the spinner / needs-you dot
        // is the fresher signal, and the dot would double-signal beside it.
        for (const id of Array.from(next)) {
          if (nextWorking.has(id) || nextWaiting.has(id)) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : current;
      });
      setWorkingAgentSessionIds(nextWorking);
      setWaitingAgentSessionIds(nextWaiting);
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
      setWaitingAgentSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
      setUnreadAgentSessionIds((current) => {
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
    <aside
      className="sidebar"
      data-collapsed={collapsed}
      data-mode={inSettings ? "settings" : "default"}
    >
      {inSettings ? null : (
        <header className="sidebar-header">
          <a className="sidebar-brand" href="#" aria-label="June">
            <img
              className="sidebar-brand-img light"
              src="/os-june-light.svg"
              alt=""
              height={16}
            />
            <img
              className="sidebar-brand-img dark"
              src="/os-june-dark.svg"
              alt=""
              height={16}
            />
            <span style={{ position: "absolute", left: -9999 }}>June</span>
          </a>
        </header>
      )}

      {inSettings ? (
        <SettingsSidebarNav
          activeTab={settingsTab}
          onSelectTab={(tab) => onSettingsTabChange?.(tab)}
          onBack={() =>
            onExitSettings ? onExitSettings() : onChangeView("notes")
          }
        />
      ) : (
        <>
          <label
            className="sidebar-search"
            onMouseDown={(event) => {
              event.preventDefault();
              openCommandPalette();
            }}
          >
            <IconMagnifyingGlass size={15} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search"
              aria-label="Search"
              readOnly
            />
            <span className="sidebar-search-kbd" aria-hidden="true">
              ⌘ K
            </span>
          </label>

          <nav className="sidebar-nav" aria-label="Primary">
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={handleNewAgentSession}
            >
              <span className="sidebar-nav-icon">
                <IconPlusMedium size={15} />
              </span>
              <span className="sidebar-nav-label">New session</span>
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
              <span className="sidebar-nav-label">Meetings</span>
            </button>
            <button
              type="button"
              className="sidebar-nav-item"
              data-active={activeView === "folders"}
              aria-current={activeView === "folders" ? "page" : undefined}
              onClick={() => onChangeView("folders")}
            >
              <span className="sidebar-nav-icon">
                <IconProjects size={15} />
              </span>
              <span className="sidebar-nav-label">Projects</span>
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
            <button
              type="button"
              className="sidebar-nav-item"
              data-active={activeView === "routines"}
              aria-current={activeView === "routines" ? "page" : undefined}
              onClick={() => onChangeView("routines")}
            >
              <span className="sidebar-nav-icon">
                <IconArrowsRepeat size={16} />
              </span>
              <span className="sidebar-nav-label">Routines</span>
            </button>
          </nav>

          <section
            className="sidebar-section sidebar-agent-section"
            aria-label="Agent sessions"
            data-active={
              activeView === "agent" || activeView === "agent-sessions"
            }
          >
            <div className="section-title section-title-with-action">
              <button
                type="button"
                className="section-title-label section-title-open"
                onClick={() => onChangeView("agent-sessions")}
              >
                Agent
              </button>
              {/* Same destination as the header — the hover affordance just
               * makes the "this opens a list" behavior legible. */}
              <button
                type="button"
                className="section-view-all"
                onClick={() => onChangeView("agent-sessions")}
              >
                View all
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
                      unread={unreadAgentSessionIds.has(session.id)}
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
                    {agentSessions.length === 0
                      ? "No sessions yet"
                      : "No matches"}
                  </div>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      <footer className="sidebar-footer">
        <SidebarIdentity
          account={account}
          menuOpen={identityMenuOpen}
          onToggleMenu={() => setIdentityMenuOpen((open) => !open)}
          onCloseMenu={() => setIdentityMenuOpen(false)}
          onOpenSettings={() => {
            setIdentityMenuOpen(false);
            onChangeView("settings");
          }}
          onSignOut={
            onSignOut
              ? () => {
                  setIdentityMenuOpen(false);
                  onSignOut();
                }
              : undefined
          }
        />
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
      {commandPaletteOpen ? (
        <CommandPalette
          inputRef={commandInputRef}
          query={commandQuery}
          groups={commandPaletteGroups}
          items={commandPaletteItems}
          activeIndex={commandActiveIndex}
          onQueryChange={setCommandQuery}
          onActiveIndexChange={setCommandActiveIndex}
          onClose={closeCommandPalette}
          onSelect={runCommandPaletteItem}
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
  const title = note.title.trim() || "New meeting";
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

function SettingsSidebarNav({
  activeTab,
  onSelectTab,
  onBack,
}: {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  onBack: () => void;
}) {
  return (
    <section
      className="sidebar-section sidebar-settings-section"
      aria-label="Settings"
    >
      <button
        type="button"
        className="sidebar-nav-item sidebar-settings-back"
        onClick={onBack}
      >
        <span className="sidebar-nav-icon">
          <IconChevronLeftSmall size={15} />
        </span>
        <span className="sidebar-nav-label">Back to app</span>
      </button>
      {SETTINGS_SIDEBAR_GROUPS.map((group) => (
        <div key={group.title} className="sidebar-settings-group">
          <div className="section-title">
            <span className="section-title-label">{group.title}</span>
          </div>
          <nav className="sidebar-nav" aria-label={`${group.title} settings`}>
            {group.items.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className="sidebar-nav-item"
                data-active={activeTab === tab.id}
                aria-current={activeTab === tab.id ? "page" : undefined}
                onClick={() => onSelectTab(tab.id)}
              >
                <span className="sidebar-nav-icon" aria-hidden>
                  {tab.icon}
                </span>
                <span className="sidebar-nav-label">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      ))}
    </section>
  );
}

function CommandPalette({
  inputRef,
  query,
  groups,
  items,
  activeIndex,
  onQueryChange,
  onActiveIndexChange,
  onClose,
  onSelect,
}: {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  groups: CommandPaletteGroup[];
  items: CommandPaletteItem[];
  activeIndex: number;
  onQueryChange: (value: string) => void;
  onActiveIndexChange: (index: number) => void;
  onClose: () => void;
  onSelect: (item: CommandPaletteItem) => void;
}) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length === 0) return;
      onActiveIndexChange(Math.min(activeIndex + 1, items.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      onActiveIndexChange(Math.max(activeIndex - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) onSelect(item);
    }
  }

  let itemIndex = 0;

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
      >
        <label className="command-palette-search">
          <IconMagnifyingGlass size={16} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder="Search meetings, sessions, or jump to..."
            aria-label="Search"
            aria-activedescendant={
              items[activeIndex]
                ? `command-palette-item-${activeIndex}`
                : undefined
            }
          />
        </label>
        <div className="command-palette-results">
          {groups.length > 0 ? (
            groups.map((group) => (
              <section className="command-palette-group" key={group.title}>
                <div className="command-palette-group-title">{group.title}</div>
                <div className="command-palette-group-list">
                  {group.items.map((item) => {
                    const index = itemIndex;
                    itemIndex += 1;
                    return (
                      <button
                        type="button"
                        id={`command-palette-item-${index}`}
                        className="command-palette-item"
                        data-active={index === activeIndex}
                        key={item.id}
                        onMouseEnter={() => onActiveIndexChange(index)}
                        onClick={() => onSelect(item)}
                      >
                        <span className="command-palette-item-icon">
                          {item.icon}
                        </span>
                        <span className="command-palette-item-label">
                          {item.label}
                        </span>
                        {item.meta ? (
                          <span className="command-palette-item-meta">
                            {item.meta}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          ) : (
            <div className="command-palette-empty">No results</div>
          )}
        </div>
        <div className="command-palette-footer" aria-hidden="true">
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>↑↓</kbd> Navigate
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}

function normalizeCommandQuery(value: string) {
  return value.trim().toLowerCase();
}

function isSearchShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "k" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

// The user's name is the settings entry point: clicking it opens a small
// popover whose actions open the settings page or sign out.
function SidebarIdentity({
  account,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onOpenSettings,
  onSignOut,
}: {
  account: AccountStatus;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onOpenSettings: () => void;
  onSignOut?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const name = accountDisplayName(account);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) onCloseMenu();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseMenu();
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, onCloseMenu]);

  return (
    <div className="sidebar-identity-wrap" ref={wrapRef}>
      <button
        type="button"
        className="sidebar-nav-item sidebar-identity"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${name}, account menu`}
        onClick={onToggleMenu}
      >
        <span className="sidebar-nav-icon">
          <IconPeople size={18} />
        </span>
        <span className="sidebar-nav-label">{name}</span>
      </button>
      {menuOpen ? (
        <div className="sidebar-identity-menu" role="menu">
          <button type="button" role="menuitem" onClick={onOpenSettings}>
            <IconSettingsGear4 size={14} />
            Settings
          </button>
          {account.signedIn && onSignOut ? (
            <>
              <div className="context-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={onSignOut}>
                <IconArrowBoxRight size={14} />
                Sign out
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function accountDisplayName(account: AccountStatus) {
  return (
    account.user?.displayName?.trim() ||
    account.user?.handle?.trim() ||
    "Account"
  );
}

function AgentSessionRow({
  session,
  selected,
  working,
  waiting,
  unread,
  deleting,
  onSelect,
  onDelete,
}: {
  session: HermesSessionInfo;
  selected: boolean;
  working: boolean;
  waiting: boolean;
  unread: boolean;
  deleting: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const title = session.title || session.preview || "Untitled session";
  const status = waiting ? "waitingForUser" : working ? "running" : undefined;
  const time = formatSessionTime(sessionTimestamp(session));
  return (
    <article
      className="note-row agent-sidebar-row"
      data-selected={selected}
      data-status={status}
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
          {status === "running" ? (
            <span role="status" aria-label="Working" title="Working">
              <DotSpinner className="agent-sidebar-spinner" />
            </span>
          ) : (
            <IconPangolin size={16} />
          )}
        </span>
        <span className="note-row-title">
          <span className="note-row-title-text">{title}</span>
        </span>
      </div>
      {waiting ? (
        <span
          className="agent-session-meta"
          role="status"
          aria-label="Needs you"
        >
          <span
            className="agent-sidebar-working"
            data-status="waitingForUser"
            title="Needs you"
          />
        </span>
      ) : unread ? (
        <span
          className="agent-session-meta"
          role="status"
          aria-label="New reply"
        >
          <span
            className="agent-sidebar-working"
            data-status="unread"
            title="New reply"
          />
        </span>
      ) : time ? (
        <span className="agent-session-meta agent-session-time">{time}</span>
      ) : null}
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

// Compact trailing timestamp for agent session rows: "now", "5m", "3h", "2d"
// while recent, then "May 2". sessionTimestamp falls back to the epoch when a
// session has no dates at all, which we render as nothing rather than 1970.
function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return "";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
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
        {hasFolder ? "Change project" : "Add to project"}
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
          Remove from project
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
        Delete meeting
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
