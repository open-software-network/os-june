import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconArrowBoxRight } from "central-icons/IconArrowBoxRight";
import { IconZap } from "central-icons/IconZap";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconRobot2 } from "central-icons/IconRobot2";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconAudio } from "central-icons/IconAudio";
import { IconBox2 } from "central-icons/IconBox2";
import { IconBrain2 } from "central-icons/IconBrain2";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconFolderShared } from "central-icons/IconFolderShared";
import { IconCreditCard1 } from "central-icons/IconCreditCard1";
import { IconDotGrid1x3Vertical } from "central-icons/IconDotGrid1x3Vertical";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";
import { IconGift1 } from "central-icons/IconGift1";
import { IconLayersThree } from "central-icons/IconLayersThree";
import { IconMagicWand } from "central-icons/IconMagicWand";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconMicrophoneSparkle } from "central-icons/IconMicrophoneSparkle";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPeople } from "central-icons/IconPeople";
import { IconPin } from "central-icons/IconPin";
import { IconGithub } from "central-icons/IconGithub";
import { IconPlugin2 } from "central-icons/IconPlugin2";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconToolbox } from "central-icons/IconToolbox";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconProjects } from "central-icons/IconProjects";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { IconGauge } from "central-icons/IconGauge";
import { IconServer1 } from "central-icons/IconServer1";
import { IconShield } from "central-icons/IconShield";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconStore1 } from "central-icons/IconStore1";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconShortcut } from "central-icons/IconShortcut";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconUnpin } from "central-icons/IconUnpin";
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
import { CategoryIcon } from "../agent/composer/CategoryIcon";
import type { ReportCategory } from "../agent/composer/reportCategory";
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
import { errorCode, messageFromError } from "../../lib/errors";
import { NOTE_DND_MIME } from "../../lib/dnd";
import { useForcedEmptyStates } from "../../lib/empty-states-demo";
import { useRecordingPresenceBounds } from "../../lib/recording-presence-bounds";
import { isPrimaryShortcut, primaryShortcutLabel } from "../../lib/platform";
import type {
  AccountStatus,
  HermesSessionInfo,
  NoteListItemDto,
  RecordingStatusDto,
  ReferralSummary,
} from "../../lib/tauri";
import { osAccountsReferralSummary } from "../../lib/tauri";
import { JuneMark } from "../account/AccountGate";
import { type SettingsTab } from "../settings/AppSettings";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { DotSpinner } from "../DotSpinner";
import { combineSourceAudioLevels, Waveform } from "../recorder/Waveform";

const NO_AGENT_SESSIONS: HermesSessionInfo[] = [];

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
  onReportIssue?: (category: ReportCategory) => void;
  onSelectNote: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onOpenMoveDialog: (noteId: string) => void;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  onNewAgentSession: () => void;
  onSelectAgentSession: (session: HermesSessionInfo) => void;
  recoverableNoteIds?: ReadonlySet<string>;
  recordingStatus?: RecordingStatusDto | null;
  recordingTitle?: string;
  onOpenRecording?: () => void;
  collapsed?: boolean;
  footerAccessory?: ReactNode;
};

type MenuState =
  | { kind: "note"; noteId: string; right: number; top: number }
  | { kind: "agent-session"; sessionId: string; right: number; top: number };

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

const AGENT_SIDEBAR_SESSION_FETCH_LIMIT = 100;
const AGENT_SIDEBAR_SESSION_LIMIT = 12;
const PINNED_AGENT_SESSION_IDS_STORAGE_KEY = "june:pinned-agent-session-ids";
const AGENT_SIDEBAR_SESSION_RETRY_DELAYS_MS = [
  250, 500, 1000, 2000, 4000, 8000, 16000, 32000,
];
const SIDEBAR_DEV_STATES_EVENT = "june:sidebar:dev-states";
const SIDEBAR_DEV_SESSION_IDS = {
  selected: "sidebar-state-selected",
  working: "sidebar-state-working",
  waiting: "sidebar-state-waiting",
  unread: "sidebar-state-unread",
  recent: "sidebar-state-recent",
  older: "sidebar-state-older",
  long: "sidebar-state-long",
} as const;

type SidebarDevStatesDetail = { show: boolean };

let sidebarDevStatesDesired = false;

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__sidebarStates = (
    show: boolean = true,
  ) => {
    sidebarDevStatesDesired = show;
    window.dispatchEvent(
      new CustomEvent<SidebarDevStatesDetail>(SIDEBAR_DEV_STATES_EVENT, {
        detail: { show },
      }),
    );
    return show
      ? "Sidebar state preview shown. Run __sidebarStates(false) to restore."
      : "Sidebar state preview restored.";
  };
}

type SidebarDevStateSnapshot = {
  sessions: HermesSessionInfo[];
  selectedSessionId?: string;
  workingSessionIds: Set<string>;
  waitingSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  deletingSessionIds: Set<string>;
  pinnedSessionIds: Set<string>;
  query: string;
};

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
      {
        id: "integrations-health",
        label: "Integrations health",
        icon: <IconGauge size={16} />,
      },
      { id: "models", label: "Models", icon: <IconBrain2 size={16} /> },
      { id: "agent", label: "Agent", icon: <IconRobot2 size={16} /> },
      {
        id: "skills",
        label: "Installed skills",
        icon: <IconPlugin2 size={16} />,
      },
      {
        id: "external-dirs",
        label: "External skill directories",
        icon: <IconFolderShared size={16} />,
      },
      {
        id: "skill-review",
        label: "Pending skill changes",
        icon: <IconShieldCheck size={16} />,
      },
      {
        id: "mcp",
        label: "MCP servers",
        icon: <IconServer1 size={16} />,
      },
      {
        id: "mcp-catalog",
        label: "MCP catalog",
        icon: <IconStore1 size={16} />,
      },
      {
        id: "mcp-diagnostics",
        label: "MCP diagnostics",
        icon: <IconHeartBeat size={16} />,
      },
      {
        id: "mcp-security",
        label: "MCP security",
        icon: <IconShield size={16} />,
      },
      {
        id: "skills-hub",
        label: "Skills hub",
        icon: <IconArrowInbox size={16} />,
      },
      {
        id: "taps",
        label: "Team skill taps",
        icon: <IconGithub size={16} />,
      },
      {
        id: "toolsets",
        label: "Toolsets",
        icon: <IconToolbox size={16} />,
      },
      {
        id: "bundles",
        label: "Bundles",
        icon: <IconLayersThree size={16} />,
      },
      {
        id: "profile-builder",
        label: "Profile builder",
        icon: <IconMagicWand size={16} />,
      },
      {
        id: "import-export",
        label: "Import / export",
        icon: <IconBox2 size={16} />,
      },
    ],
  },
  {
    title: "App",
    items: [
      { id: "about", label: "About", icon: <IconCircleInfo size={16} /> },
    ],
  },
];

/**
 * Settings tabs introduced by the admin-surfaces PR, hidden from the nav until
 * they're stabilized. The pre-PR tabs (General, Billing, Shortcuts, Dictation,
 * Audio, Models, Agent, Installed skills, About) stay visible, plus External
 * skill directories (PR-new but verified working). These are hidden, not
 * removed: tabs, panels, and logic are all intact. Re-enable one by deleting its
 * id here; restore the full nav by deleting this set and the `.filter` in
 * SettingsSidebar that uses it. See docs/settings-focus-runbook.md.
 */
export const HIDDEN_SETTINGS_TABS: ReadonlySet<SettingsTab> =
  new Set<SettingsTab>([
    "skill-review",
    "mcp",
    "mcp-catalog",
    "mcp-diagnostics",
    "mcp-security",
    "skills-hub",
    "taps",
    "toolsets",
    "bundles",
    "profile-builder",
    "integrations-health",
    "import-export",
  ]);

export function Sidebar({
  notes,
  activeView,
  account = { signedIn: false, configured: false },
  settingsTab = "general",
  onSettingsTabChange,
  onChangeView,
  onExitSettings,
  onSignOut,
  onReportIssue,
  onSelectNote,
  onDeleteNote,
  onOpenMoveDialog,
  onRemoveNoteFromFolder,
  onNewAgentSession,
  onSelectAgentSession,
  recoverableNoteIds,
  recordingStatus,
  recordingTitle = "New note",
  onOpenRecording,
  collapsed = false,
  footerAccessory,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const commandInputRef = useRef<HTMLInputElement>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [identityMenuOpen, setIdentityMenuOpen] = useState(false);
  const [referralDialogOpen, setReferralDialogOpen] = useState(false);
  const [referralSummary, setReferralSummary] =
    useState<ReferralSummary | null>(null);
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralError, setReferralError] = useState<string | null>(null);
  // The deployment can simply not offer referrals (a 404 from /referrals/me).
  // That's not a transient failure, so it gets a calm message with no retry.
  const [referralUnavailable, setReferralUnavailable] = useState(false);
  const [referralCopyError, setReferralCopyError] = useState<string | null>(
    null,
  );
  const [referralCopied, setReferralCopied] = useState(false);
  const searchShortcut = primaryShortcutLabel("K");
  const newSessionShortcut = primaryShortcutLabel("N");
  const inSettings = activeView === "settings";
  const [allAgentSessions, setAgentSessions] = useState<HermesSessionInfo[]>(
    [],
  );
  // __emptyStates() preview (dev console): the agent section renders its
  // "No sessions yet" line as a fresh install would, real data untouched.
  const agentSessions = useForcedEmptyStates()
    ? NO_AGENT_SESSIONS
    : allAgentSessions;
  const [pinnedAgentSessionIds, setPinnedAgentSessionIds] = useState<
    Set<string>
  >(() => readPinnedAgentSessionIds());
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
  const sidebarDevStateSnapshotRef = useRef<SidebarDevStateSnapshot | null>(
    null,
  );

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
    writePinnedAgentSessionIds(pinnedAgentSessionIds);
  }, [pinnedAgentSessionIds]);

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
  const pinnedAgentSessionOrder = useMemo(
    () => buildPinnedSessionOrderIndex(pinnedAgentSessionIds),
    [pinnedAgentSessionIds],
  );
  const pinnedAgentSessions = useMemo(
    () =>
      filteredAgentSessions
        .filter((session) => pinnedAgentSessionIds.has(session.id))
        .sort(
          (a, b) =>
            pinnedSessionOrder(pinnedAgentSessionOrder, a.id) -
            pinnedSessionOrder(pinnedAgentSessionOrder, b.id),
        ),
    [filteredAgentSessions, pinnedAgentSessionIds, pinnedAgentSessionOrder],
  );
  const visibleAgentSessions = useMemo(
    () =>
      filteredAgentSessions
        .filter((session) => !pinnedAgentSessionIds.has(session.id))
        .slice(0, AGENT_SIDEBAR_SESSION_LIMIT),
    [filteredAgentSessions, pinnedAgentSessionIds],
  );

  async function loadReferralSummary() {
    if (!account.signedIn || account.localDev) return;
    setReferralLoading(true);
    setReferralError(null);
    setReferralUnavailable(false);
    try {
      setReferralSummary(await osAccountsReferralSummary());
    } catch (error) {
      setReferralUnavailable(errorCode(error) === "referrals_unavailable");
      setReferralError(messageFromError(error));
    } finally {
      setReferralLoading(false);
    }
  }

  function openReferralDialog() {
    if (account.localDev) return;
    setReferralDialogOpen(true);
    setReferralCopied(false);
    setReferralCopyError(null);
    if (!referralLoading) {
      void loadReferralSummary();
    }
  }

  async function copyReferralLink() {
    if (!referralSummary) return;
    try {
      await navigator.clipboard.writeText(referralSummary.url);
      setReferralCopyError(null);
      setReferralCopied(true);
    } catch {
      setReferralCopyError(
        "Could not copy the link. Select it and copy manually.",
      );
    }
  }

  // Reset the "Copied" affordance the way every other copy button does
  // (NoteEditor, dictation rows): a single effect with cleanup, so closing
  // the dialog mid-flight can't fire a stray setState.
  useEffect(() => {
    if (!referralCopied) return;
    const timer = window.setTimeout(() => setReferralCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [referralCopied]);

  const commandPaletteGroups = useMemo<CommandPaletteGroup[]>(() => {
    const normalized = normalizeCommandQuery(commandQuery);
    const matches = (item: CommandPaletteItem) =>
      !normalized || item.searchText.includes(normalized);

    const recentItems: CommandPaletteItem[] = [
      ...notes.slice(0, 5).map((note) => {
        const title = note.title.trim() || "New note";
        return {
          id: `note:${note.id}`,
          label: title,
          meta: "Meeting note",
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
          meta: "Session",
          icon: <IconBubble3 size={15} />,
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
        label: "Go to Meeting notes",
        icon: <IconNoteText size={15} />,
        searchText: normalizeCommandQuery("meeting notes meetings go to"),
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
        icon: <IconZap size={15} />,
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

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    function applySidebarDevStates(show: boolean) {
      if (!show) {
        const snapshot = sidebarDevStateSnapshotRef.current;
        if (!snapshot) return;
        setAgentSessions(snapshot.sessions);
        setSelectedAgentSessionId(snapshot.selectedSessionId);
        setWorkingAgentSessionIds(new Set(snapshot.workingSessionIds));
        setWaitingAgentSessionIds(new Set(snapshot.waitingSessionIds));
        setUnreadAgentSessionIds(new Set(snapshot.unreadSessionIds));
        setDeletingAgentSessionIds(new Set(snapshot.deletingSessionIds));
        setPinnedAgentSessionIds(new Set(snapshot.pinnedSessionIds));
        workingAgentSessionIdsRef.current = new Set(snapshot.workingSessionIds);
        setQuery(snapshot.query);
        sidebarDevStateSnapshotRef.current = null;
        return;
      }

      if (
        sidebarDevStateSnapshotRef.current &&
        agentSessions[0]?.id === SIDEBAR_DEV_SESSION_IDS.selected
      ) {
        return;
      }

      if (!sidebarDevStateSnapshotRef.current) {
        sidebarDevStateSnapshotRef.current = {
          sessions: agentSessions,
          selectedSessionId: selectedAgentSessionId,
          workingSessionIds: new Set(workingAgentSessionIds),
          waitingSessionIds: new Set(waitingAgentSessionIds),
          unreadSessionIds: new Set(unreadAgentSessionIds),
          deletingSessionIds: new Set(deletingAgentSessionIds),
          pinnedSessionIds: new Set(pinnedAgentSessionIds),
          query,
        };
      }

      setQuery("");
      setMenu(null);
      setIdentityMenuOpen(false);
      setCommandPaletteOpen(false);
      setAgentSessions(buildSidebarDevStateSessions());
      setSelectedAgentSessionId(SIDEBAR_DEV_SESSION_IDS.selected);
      setWorkingAgentSessionIds(new Set([SIDEBAR_DEV_SESSION_IDS.working]));
      setWaitingAgentSessionIds(new Set([SIDEBAR_DEV_SESSION_IDS.waiting]));
      setUnreadAgentSessionIds(new Set([SIDEBAR_DEV_SESSION_IDS.unread]));
      setDeletingAgentSessionIds(new Set());
      setPinnedAgentSessionIds(new Set([SIDEBAR_DEV_SESSION_IDS.selected]));
      workingAgentSessionIdsRef.current = new Set([
        SIDEBAR_DEV_SESSION_IDS.working,
      ]);
      onChangeView("agent");
    }

    const onDevStates = (event: Event) => {
      const detail = (event as CustomEvent<SidebarDevStatesDetail>).detail;
      applySidebarDevStates(Boolean(detail?.show));
    };

    applySidebarDevStates(sidebarDevStatesDesired);
    window.addEventListener(SIDEBAR_DEV_STATES_EVENT, onDevStates);
    return () =>
      window.removeEventListener(SIDEBAR_DEV_STATES_EVENT, onDevStates);
  }, [
    agentSessions,
    deletingAgentSessionIds,
    onChangeView,
    query,
    pinnedAgentSessionIds,
    selectedAgentSessionId,
    unreadAgentSessionIds,
    waitingAgentSessionIds,
    workingAgentSessionIds,
  ]);

  function dispatchAgentEvent<T>(name: string, detail?: T) {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }, 0);
  }

  function handleNewAgentSession() {
    setSelectedAgentSessionId(undefined);
    markAgentNewSessionPending();
    onNewAgentSession();
    dispatchAgentEvent(AGENT_NEW_SESSION_EVENT);
  }

  function togglePinnedAgentSession(sessionId: string) {
    setPinnedAgentSessionIds((current) => {
      const ordered = Array.from(current).filter((id) => id !== sessionId);
      if (!current.has(sessionId)) {
        ordered.unshift(sessionId);
      }
      return new Set(ordered);
    });
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
      listHermesSessions({ limit: AGENT_SIDEBAR_SESSION_FETCH_LIMIT })
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
      setAgentSessions(
        detail.sessions.slice(0, AGENT_SIDEBAR_SESSION_FETCH_LIMIT),
      );
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
    if (menu?.kind === "note" && menu.noteId === noteId) {
      setMenu(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setMenu({
      kind: "note",
      noteId,
      right: window.innerWidth - rect.right,
      top: rect.bottom + 4,
    });
  }

  function openMenuForAgentSession(sessionId: string, anchor: HTMLElement) {
    if (menu?.kind === "agent-session" && menu.sessionId === sessionId) {
      setMenu(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setMenu({
      kind: "agent-session",
      sessionId,
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
      setPinnedAgentSessionIds((current) => {
        if (!current.has(session.id)) return current;
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

  const menuAgentSession =
    menu?.kind === "agent-session"
      ? agentSessions.find((session) => session.id === menu.sessionId)
      : undefined;
  const newAgentSessionActive =
    activeView === "agent" && !selectedAgentSessionId;

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
          {recordingStatus ? (
            <SidebarRecordingIndicator
              status={recordingStatus}
              title={recordingTitle}
              onOpen={onOpenRecording}
            />
          ) : null}
        </header>
      )}

      {inSettings ? (
        <SettingsSidebarNav
          activeTab={settingsTab}
          localDev={account.localDev === true}
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
              {searchShortcut}
            </span>
          </label>

          <nav className="sidebar-nav" aria-label="Primary">
            <button
              type="button"
              className="sidebar-nav-item"
              data-active={newAgentSessionActive || undefined}
              aria-current={newAgentSessionActive ? "page" : undefined}
              onClick={handleNewAgentSession}
            >
              <span className="sidebar-nav-icon">
                <IconPlusMedium size={15} />
              </span>
              <span className="sidebar-nav-label">New session</span>
              <kbd className="sidebar-nav-shortcut" aria-hidden="true">
                {newSessionShortcut}
              </kbd>
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
              <span className="sidebar-nav-label">Meeting notes</span>
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
                <IconZap size={16} />
              </span>
              <span className="sidebar-nav-label">Routines</span>
            </button>
          </nav>

          {pinnedAgentSessions.length > 0 ? (
            <section
              className="sidebar-section sidebar-pinned-section"
              aria-label="Pinned agent sessions"
            >
              <div className="section-title">
                <span className="section-title-label">Pinned</span>
              </div>
              <div className="notes-nav sidebar-pinned-list">
                {pinnedAgentSessions.map((session) => (
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
                    menuOpen={
                      menu?.kind === "agent-session" &&
                      menu.sessionId === session.id
                    }
                    onSelect={() => {
                      setSelectedAgentSessionId(session.id);
                      onSelectAgentSession(session);
                    }}
                    onOpenMenu={(anchor) =>
                      openMenuForAgentSession(session.id, anchor)
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section
            className="sidebar-section sidebar-agent-section"
            aria-label="Sessions"
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
                Sessions
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
                {visibleAgentSessions.length > 0 ? (
                  visibleAgentSessions.map((session) => (
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
                      menuOpen={
                        menu?.kind === "agent-session" &&
                        menu.sessionId === session.id
                      }
                      onSelect={() => {
                        setSelectedAgentSessionId(session.id);
                        onSelectAgentSession(session);
                      }}
                      onOpenMenu={(anchor) =>
                        openMenuForAgentSession(session.id, anchor)
                      }
                    />
                  ))
                ) : (
                  <div className="sidebar-empty">
                    {agentSessions.length === 0
                      ? "No sessions yet"
                      : filteredAgentSessions.length === 0
                        ? "No matches"
                        : "No other sessions"}
                  </div>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      <footer className="sidebar-footer">
        {footerAccessory}
        <SidebarIdentity
          account={account}
          menuOpen={identityMenuOpen}
          onToggleMenu={() => setIdentityMenuOpen((open) => !open)}
          onCloseMenu={() => setIdentityMenuOpen(false)}
          onInviteFriends={
            account.signedIn && !account.localDev
              ? () => {
                  setIdentityMenuOpen(false);
                  openReferralDialog();
                }
              : undefined
          }
          onOpenSettings={() => {
            setIdentityMenuOpen(false);
            onChangeView("settings");
          }}
          onReportIssue={
            onReportIssue
              ? (category) => {
                  setIdentityMenuOpen(false);
                  onReportIssue(category);
                }
              : undefined
          }
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

      <ReferralDialog
        open={referralDialogOpen}
        summary={referralSummary}
        loading={referralLoading}
        error={referralError}
        unavailable={referralUnavailable}
        copyError={referralCopyError}
        copied={referralCopied}
        onClose={() => setReferralDialogOpen(false)}
        onRetry={() => void loadReferralSummary()}
        onCopy={() => void copyReferralLink()}
      />

      {menu?.kind === "note" ? (
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
      {menu?.kind === "agent-session" && menuAgentSession ? (
        <AgentSessionContextMenu
          pinned={pinnedAgentSessionIds.has(menuAgentSession.id)}
          deleting={deletingAgentSessionIds.has(menuAgentSession.id)}
          right={menu.right}
          top={menu.top}
          onTogglePinned={() => togglePinnedAgentSession(menuAgentSession.id)}
          onDelete={() => {
            setAgentSessionDeleteError(null);
            setAgentSessionToDelete(menuAgentSession);
          }}
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

function SidebarRecordingIndicator({
  status,
  title,
  onOpen,
}: {
  status: RecordingStatusDto;
  title: string;
  onOpen?: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const recording = status.state === "recording";
  useRecordingPresenceBounds(buttonRef);
  const meterLevel =
    status.sources && status.sources.length > 0
      ? combineSourceAudioLevels(status.sources)
      : status.level;

  return (
    <button
      ref={buttonRef}
      type="button"
      className="sidebar-recording-indicator"
      data-state={status.state}
      onClick={onOpen}
      aria-label={`Open recording: ${title}`}
      title="Open recording"
    >
      <span className="sidebar-recording-dot" aria-hidden />
      <Waveform level={meterLevel} active={recording} />
    </button>
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

function buildSidebarDevStateSessions(): HermesSessionInfo[] {
  const now = Date.now();
  const minutesAgo = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  const daysAgo = (days: number) =>
    new Date(now - days * 24 * 60 * 60_000).toISOString();
  const session = (
    id: string,
    title: string,
    preview: string,
    lastActive: string,
  ): HermesSessionInfo => ({
    id,
    title,
    preview,
    source: "sidebar-dev",
    model: "dev-preview",
    started_at: lastActive,
    last_active: lastActive,
    message_count: 12,
  });

  return [
    session(
      SIDEBAR_DEV_SESSION_IDS.selected,
      "Selected session",
      "Open conversation row with selected background.",
      minutesAgo(2),
    ),
    session(
      SIDEBAR_DEV_SESSION_IDS.working,
      "Working spinner",
      "Dot spinner in the trailing timestamp slot.",
      minutesAgo(4),
    ),
    session(
      SIDEBAR_DEV_SESSION_IDS.waiting,
      "Needs you",
      "Terracotta status dot with title emphasis.",
      minutesAgo(8),
    ),
    session(
      SIDEBAR_DEV_SESSION_IDS.unread,
      "New reply",
      "Unread reply dot in the trailing status slot.",
      minutesAgo(16),
    ),
    session(
      SIDEBAR_DEV_SESSION_IDS.recent,
      "Recent timestamp",
      "Compact relative time at the right edge.",
      minutesAgo(43),
    ),
    session(
      SIDEBAR_DEV_SESSION_IDS.older,
      "Older timestamp",
      "Calendar date instead of relative time.",
      daysAgo(9),
    ),
    session(
      SIDEBAR_DEV_SESSION_IDS.long,
      "Very long session title that should truncate cleanly before the right edge state slot",
      "Exercises title ellipsis and trailing slot spacing.",
      minutesAgo(91),
    ),
  ];
}

function SettingsSidebarNav({
  activeTab,
  localDev,
  onSelectTab,
  onBack,
}: {
  activeTab: SettingsTab;
  localDev: boolean;
  onSelectTab: (tab: SettingsTab) => void;
  onBack: () => void;
}) {
  // Hide the admin-surfaces-PR tabs until stabilized, keeping the pre-PR billing
  // rule (billing is hidden in local dev). Empty groups drop out so their
  // headers don't render.
  const groups = SETTINGS_SIDEBAR_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        !HIDDEN_SETTINGS_TABS.has(item.id) &&
        !(localDev && item.id === "billing"),
    ),
  })).filter((group) => group.items.length > 0);

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
      {groups.map((group) => (
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
            placeholder="Search meeting notes, sessions, or jump to..."
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
  return event.key.toLowerCase() === "k" && isPrimaryShortcut(event);
}

function ReferralDialog({
  open,
  summary,
  loading,
  error,
  unavailable,
  copyError,
  copied,
  onClose,
  onRetry,
  onCopy,
}: {
  open: boolean;
  summary: ReferralSummary | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  copyError: string | null;
  copied: boolean;
  onClose: () => void;
  onRetry: () => void;
  onCopy: () => void;
}) {
  const pendingFriends = summary?.pendingCount ?? 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Give a month, get a month"
      className="referral-dialog"
      width={640}
    >
      <div className="referral-split">
        <div className="referral-hero">
          <span className="referral-hero-logo" aria-hidden>
            <JuneMark />
          </span>
          <span className="referral-hero-eyebrow">
            <IconGift1 size={13} />
            Refer a friend
          </span>
          <p className="referral-hero-title">Give a month, get a month</p>
          <p className="referral-hero-copy">
            Share June with a friend. They get a free month, and when they
            subscribe, so do you.
          </p>
        </div>
        <div className="referral-panel">
          {loading ? (
            <div className="referral-dialog-status" role="status">
              <DotSpinner /> Loading referral link
            </div>
          ) : unavailable ? (
            // Deployment doesn't offer referrals — retrying can't fix that, so
            // there's no "Try again", just a calm note.
            <div className="referral-dialog-status">
              <p>Invite links aren't available yet. Check back soon.</p>
            </div>
          ) : error ? (
            <div className="referral-error-card">
              <span className="referral-error-title">
                Invite link unavailable
              </span>
              <p>{error}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onRetry}
              >
                Try again
              </button>
            </div>
          ) : summary ? (
            <>
              <span className="referral-panel-title">
                Share your invite link
              </span>
              <div className="referral-link-field">
                <input
                  className="referral-link-url"
                  value={summary.url}
                  readOnly
                  aria-label="Invite link"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  className="referral-copy-inset"
                  onClick={onCopy}
                >
                  {copied ? (
                    <IconCheckmark1Small size={14} />
                  ) : (
                    <IconClipboard size={14} />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {copyError ? (
                <p className="referral-copy-error">{copyError}</p>
              ) : null}
              <div className="referral-stats">
                <div>
                  <span className="referral-stat-value">
                    {summary.qualifiedCount}
                  </span>
                  <span className="referral-stat-label">Friends referred</span>
                </div>
              </div>
              {pendingFriends > 0 ? (
                <p className="referral-progress-note">
                  {pendingFriends} invited{" "}
                  {pendingFriends === 1 ? "friend is" : "friends are"} waiting
                  to subscribe.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

// The user's name is the settings entry point: clicking it opens a small
// popover whose actions open the settings page or sign out.
// The report shortcuts in the account menu: the same set as the composer's
// "+" popover, minus attaching a file. Action-phrased to read as menu verbs.
const REPORT_MENU_ITEMS: { category: ReportCategory; label: string }[] = [
  { category: "bug", label: "Report a bug" },
  { category: "feedback", label: "Send feedback" },
  { category: "feature", label: "Request a feature" },
];

function SidebarIdentity({
  account,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onInviteFriends,
  onOpenSettings,
  onReportIssue,
  onSignOut,
}: {
  account: AccountStatus;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onInviteFriends?: () => void;
  onOpenSettings: () => void;
  onReportIssue?: (category: ReportCategory) => void;
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
          {onInviteFriends ? (
            <button
              type="button"
              role="menuitem"
              className="sidebar-invite-item"
              onClick={onInviteFriends}
            >
              <IconGift1 size={14} />
              Invite friends
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={onOpenSettings}>
            <IconSettingsGear4 size={14} />
            Settings
          </button>
          {onReportIssue
            ? REPORT_MENU_ITEMS.map((item) => (
                <button
                  key={item.category}
                  type="button"
                  role="menuitem"
                  onClick={() => onReportIssue(item.category)}
                >
                  <span
                    className="sidebar-report-icon"
                    data-category={item.category}
                  >
                    <CategoryIcon category={item.category} size={14} />
                  </span>
                  {item.label}
                </button>
              ))
            : null}
          {account.signedIn && !account.localDev && onSignOut ? (
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

function readPinnedAgentSessionIds() {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(
      PINNED_AGENT_SESSION_IDS_STORAGE_KEY,
    );
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set<string>();
  }
}

function writePinnedAgentSessionIds(ids: ReadonlySet<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PINNED_AGENT_SESSION_IDS_STORAGE_KEY,
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    // Private browsing / locked-down WebViews may reject storage writes.
  }
}

function buildPinnedSessionOrderIndex(ids: ReadonlySet<string>) {
  const indexById = new Map<string, number>();
  let index = 0;
  for (const id of ids) {
    indexById.set(id, index);
    index += 1;
  }
  return indexById;
}

function pinnedSessionOrder(
  indexById: ReadonlyMap<string, number>,
  sessionId: string,
) {
  return indexById.get(sessionId) ?? Number.MAX_SAFE_INTEGER;
}

function AgentSessionRow({
  session,
  selected,
  working,
  waiting,
  unread,
  deleting,
  menuOpen,
  onSelect,
  onOpenMenu,
}: {
  session: HermesSessionInfo;
  selected: boolean;
  working: boolean;
  waiting: boolean;
  unread: boolean;
  deleting: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
}) {
  const title = session.title || session.preview || "Untitled session";
  const status = waiting ? "waitingForUser" : working ? "running" : undefined;
  const time = formatSessionTime(sessionTimestamp(session));
  const menuRef = useRef<HTMLButtonElement>(null);
  return (
    <article
      className="note-row agent-sidebar-row"
      data-selected={selected}
      data-status={status}
      data-menu-open={menuOpen || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (deleting) return;
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
        <span className="note-row-title">
          <span className="note-row-title-text">{title}</span>
        </span>
      </div>
      {waiting ? (
        <span
          className="agent-session-meta agent-session-status"
          role="status"
          aria-label="Needs you"
        >
          <span
            className="agent-sidebar-working"
            data-status="waitingForUser"
            title="Needs you"
          />
        </span>
      ) : working ? (
        <span
          className="agent-session-meta agent-session-status"
          role="status"
          aria-label="Working"
        >
          <DotSpinner className="agent-sidebar-spinner" />
        </span>
      ) : unread ? (
        <span
          className="agent-session-meta agent-session-status"
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
      <span className="agent-session-actions">
        <button
          ref={menuRef}
          type="button"
          className="note-row-menu agent-session-row-menu"
          aria-label={`Actions for ${title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={deleting}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenMenu(event.currentTarget);
          }}
        >
          <IconDotGrid1x3Vertical size={14} />
        </button>
      </span>
    </article>
  );
}

function AgentSessionContextMenu({
  pinned,
  deleting,
  right,
  top,
  onTogglePinned,
  onDelete,
  onClose,
}: {
  pinned: boolean;
  deleting: boolean;
  right: number;
  top: number;
  onTogglePinned: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
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
          onTogglePinned();
          onClose();
        }}
      >
        {pinned ? <IconUnpin size={14} /> : <IconPin size={14} />}
        {pinned ? "Unpin session" : "Pin session"}
      </button>
      <div className="context-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="destructive"
        disabled={deleting}
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <IconTrashCan size={14} />
        Delete session
      </button>
    </div>
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
