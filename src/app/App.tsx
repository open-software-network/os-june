import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRight } from "central-icons/IconArrowRight";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { AccountGate, JuneMark } from "../components/account/AccountGate";
import { TrialGate } from "../components/account/TrialGate";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  AgentWorkspace,
  markAgentNewSessionPending,
  type AgentNewSessionDetail,
  type AgentSessionsChangedDetail,
} from "../components/agent/AgentWorkspace";
import { AgentSessionsList } from "../components/agent/AgentSessionsList";
import type { AgentSessionsListHandle } from "../components/agent/AgentSessionsList";
import type { ReportCategory } from "../components/agent/composer/reportCategory";
import { DictationHistoryView } from "../components/dictation/DictationHistoryView";
import { FoldersWorkspace } from "../components/folders/FoldersWorkspace";
import { RoutinesView } from "../components/routines/RoutinesView";
import { MoveNoteToFolderDialog } from "../components/folders/MoveNoteToFolderDialog";
import { MoveSessionToProjectDialog } from "../components/folders/MoveSessionToProjectDialog";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import { GlobalRecorderPill } from "../components/recorder/GlobalRecorderPill";
import type { GlobalRecorderDemoApi } from "../lib/global-recorder-demo";
import {
  NotesList,
  type NotesListHandle,
} from "../components/notes-list/NotesList";
import { PermissionBanner } from "../components/permissions/PermissionBanner";
import {
  AppSettings,
  type SettingsTab,
} from "../components/settings/AppSettings";
import { Sidebar, type SidebarView } from "../components/sidebar/Sidebar";
import { TabBar, type TabItem } from "../components/tabs/TabBar";
import {
  defaultNav,
  makeTabId,
  navEquals,
  type Tab,
  type TabNav,
} from "./tabs/tabs";
import { BreadcrumbBar } from "../components/ui/BreadcrumbBar";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconProjects } from "central-icons/IconProjects";
import { IconZap } from "central-icons/IconZap";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { Dialog } from "../components/ui/Dialog";
import {
  assignNoteToFolder,
  assignSessionToFolder,
  bootstrapApp,
  checkRecordingSourceReadiness,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  deleteNotes,
  dictationHelperCommand,
  finishRecording,
  getRecordingStatus,
  getNote,
  LIVE_TRANSCRIPT_EVENT,
  listNotes,
  listSessionFolders,
  openPrivacySettings,
  osAccountsLogout,
  osAccountsTopUp,
  pauseRecording,
  removeNoteFromFolder,
  removeSessionFromFolder,
  recoverRecording,
  renameFolder,
  resumeRecording,
  retryProcessing,
  startRecording,
  updateNote,
  agentHudHide,
  agentHudShow,
  type LiveTranscriptEventDto,
} from "../lib/tauri";
import {
  playRecordingSound,
  preloadRecordingSounds,
} from "../lib/recording-sounds";
import { isMacLikePlatform, isPrimaryShortcut } from "../lib/platform";
import { MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import {
  AGENT_GALLERY_EVENT,
  AGENT_OPEN_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  dispatchAgentSessionStatus,
  type AgentGalleryDetail,
  type AgentSessionStatusDetail,
} from "../lib/agent-events";
import { notifyAgentSessionStatus } from "../lib/agent-notifications";
import { messageFromError } from "../lib/errors";
import { parseDictationHelperEvent } from "../lib/dictation-events";
import { listHermesSessions, titleFromPrompt } from "../lib/hermes-adapter";
import { upsertLiveTranscriptEvent } from "../lib/live-transcript-preview";
import {
  RECORDING_INACTIVITY_RESPONSE_MS,
  RECORDING_INACTIVITY_SNOOZE_MS,
  nextRecordingInactivityDecision,
  recordingHasActivity,
  type RecordingInactivityTracker,
} from "../lib/recording-inactivity";
import {
  notifyRecordingAutoPaused,
  notifyRecordingStillMeetingPrompt,
} from "../lib/recording-notifications";
import {
  AGENT_MENU_BAR_NEW_SESSION_EVENT,
  AGENT_MENU_BAR_OPEN_SESSION_EVENT,
  AGENT_MENU_BAR_SET_AGENT_HUD_EVENT,
  CLOSE_TAB_EVENT,
  OPEN_SETTINGS_EVENT,
  buildAgentMenuBarState,
  emitAgentMenuBarState,
} from "../lib/menu-bar";
import {
  AGENT_HUD_VISIBILITY_CHANGED_EVENT,
  getAgentHudEnabled,
  setAgentHudEnabled,
  type AgentHudVisibilityChangedDetail,
} from "../lib/agent-hud-settings";
import type {
  BootstrapResponse,
  FolderDto,
  NoteDto,
  RecordingStatusDto,
  AccountStatus,
  HermesSessionInfo,
} from "../lib/tauri";
import type {
  NoteListItemDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
} from "../lib/tauri";
import { useAccountStatus } from "../lib/account-status";
import {
  applyOnboardingReplayFlag,
  isOnboardingComplete,
  markOnboardingComplete,
  shouldReplayOnboarding,
} from "../lib/onboarding";
import { shouldBlockOnSignIn, shouldBlockOnTrial } from "../lib/account-gate";
import {
  checkScribeUpdate,
  relaunchScribe,
  type ScribeUpdate,
} from "../lib/updater";
import { shouldPollProcessingStatus } from "./processing-polling";
import { attachScrollThumbFade } from "../lib/scroll-thumb-fade";
import { createInitialState, notesReducer } from "./state/app-state";
import { handleSidebarResizeStart } from "./sidebar-resize";
import {
  checkForScribeUpdate,
  prepareScribeUpdate,
  startPeriodicScribeUpdateChecks,
  type UpdateCheckMode,
  type UpdateInstallProgress,
  type UpdatePromptPayload,
} from "./update-decision";

const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 188;
const SIDEBAR_MAX_WIDTH = 320;
const SIDEBAR_COLLAPSE_WIDTH = 160;
const CHECK_FOR_UPDATES_EVENT = "scribe://check-for-updates";
const AGENT_MENU_BAR_SESSION_FETCH_LIMIT = 100;
const AGENT_MENU_BAR_SESSION_LIMIT = 6;
const AGENT_MENU_BAR_SESSION_RETRY_DELAYS_MS = [
  250, 500, 1000, 2000, 4000, 8000,
];
const ACCESSIBILITY_PERMISSION_REFRESH_INTERVAL_MS = 1000;
const ACCESSIBILITY_PERMISSION_REFRESH_TIMEOUT_MS = 120_000;
// Floor for the note card so the sidebar can't be dragged wide enough to
// crush it into a sliver — it always keeps a usable width plus its gutters.
const MAIN_PANEL_MIN_WIDTH = 420;

// Largest the sidebar may grow given the live window width: never past its own
// cap, and never so far that the main panel drops below its floor. Falls back
// to the sidebar min on very narrow windows where both can't be satisfied.
function sidebarMaxWidth() {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - MAIN_PANEL_MIN_WIDTH),
  );
}

const TAB_ICON_SIZE = 14;

type RecordingInactivityPrompt = {
  sessionId: string;
  expiresAt: number;
};

// The icon + label a tab shows for a snapshot. Titles for entity views (note,
// project, agent session) are looked up live from the loaded data, so a tab's
// label tracks renames without storing a stale copy.
function tabMeta(
  nav: TabNav,
  notes: NoteListItemDto[],
  folders: FolderDto[],
  sessions: HermesSessionInfo[],
): { title: string; icon: ReactNode } {
  switch (nav.view) {
    case "meetings": {
      const note = nav.noteId
        ? notes.find((n) => n.id === nav.noteId)
        : undefined;
      return {
        title: note?.title?.trim() || "New note",
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
      };
    }
    case "folders": {
      const folder = nav.folderId
        ? folders.find((f) => f.id === nav.folderId)
        : undefined;
      return {
        title: folder?.name?.trim() || "Projects",
        icon: <IconProjects size={TAB_ICON_SIZE} />,
      };
    }
    case "agent": {
      const session = nav.agentSessionId
        ? sessions.find((s) => s.id === nav.agentSessionId)
        : undefined;
      return {
        title: session?.title?.trim() || "New session",
        icon: <IconBubble3 size={TAB_ICON_SIZE} />,
      };
    }
    case "agent-sessions":
      return {
        title: "Sessions",
        icon: <IconBubble3 size={TAB_ICON_SIZE} />,
      };
    case "all-notes":
      return {
        title: "All notes",
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
      };
    case "routines":
      return {
        title: "Routines",
        icon: <IconZap size={TAB_ICON_SIZE} />,
      };
    case "dictation":
      return {
        title: "Dictation",
        icon: <IconMicrophone size={TAB_ICON_SIZE} />,
      };
    case "settings":
      return {
        title: "Settings",
        icon: <IconSettingsGear4 size={TAB_ICON_SIZE} />,
      };
    case "notes":
    default:
      return {
        title: "Notes",
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
      };
  }
}

export function App() {
  const replayOnboarding = shouldReplayOnboarding();
  const [state, dispatch] = useReducer(
    notesReducer,
    undefined,
    createInitialState,
  );
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarTransition, setSidebarTransition] = useState<"none" | "smooth">(
    "none",
  );
  const [bootstrapped, setBootstrapped] = useState(false);
  // macOS launches on a fresh agent session. The Windows installer does not
  // bundle Hermes yet, so Windows starts on meeting notes instead of promising
  // a turnkey agent runtime.
  const [activeView, setActiveView] = useState<SidebarView>(() => {
    if (!isMacLikePlatform()) return "notes";
    markAgentNewSessionPending();
    return "agent";
  });
  const activeViewRef = useRef<SidebarView>(activeView);
  activeViewRef.current = activeView;
  // Browser-style tabs. Each tab is a saved navigation snapshot; the active tab
  // mirrors live navigation (so a single tab behaves exactly like before),
  // while switching or opening a tab restores its snapshot. The first tab
  // matches the launch view (agent hero on mac, notes elsewhere).
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: makeTabId(), nav: { view: isMacLikePlatform() ? "agent" : "notes" } },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]!.id);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  // Set while restoring a tab's snapshot into live state: the capture effect
  // skips writes until live navigation settles onto the target (note loads are
  // async), so a half-applied snapshot never overwrites the tab it came from.
  const restoreTargetRef = useRef<TabNav | null>(null);
  const [activeAgentSession, setActiveAgentSession] =
    useState<HermesSessionInfo>();
  // Reactive copy of the known agent sessions for the "view all" list and
  // project (folder) surfaces; the menu-bar refs below stay the source for
  // native menu state.
  const [agentSessions, setAgentSessions] = useState<HermesSessionInfo[]>([]);
  const [agentWorkingSessionIds, setAgentWorkingSessionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [agentWaitingSessionIds, setAgentWaitingSessionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // sessionId -> project (folder) ids. Sessions live in Hermes, so their
  // project assignments are tracked separately from the notes state.
  const [sessionFolders, setSessionFolders] = useState<
    Record<string, string[]>
  >({});
  const [moveDialogSessionIds, setMoveDialogSessionIds] = useState<
    string[] | null
  >(null);
  // Where an open agent session was drilled into from — a project or the
  // Routines run history — drives the breadcrumb above the agent workspace,
  // mirroring notes-from-folder.
  const [agentOrigin, setAgentOrigin] = useState<
    { kind: "project"; folderId: string } | { kind: "routines" }
  >();
  // Set when "New session" is started from a project: the next brand-new
  // session AgentWorkspace selects gets filed into that project.
  const pendingSessionProjectRef = useRef<{
    folderId: string;
    knownSessionIds: Set<string>;
  } | null>(null);
  const agentMenuBarSessionsRef = useRef<HermesSessionInfo[]>([]);
  const agentMenuBarWorkingSessionIdsRef = useRef<Set<string>>(new Set());
  const agentMenuBarWaitingSessionIdsRef = useRef<Set<string>>(new Set());
  const agentMenuBarLastStatusRef = useRef<AgentSessionStatusDetail>();
  const agentHudEnabledRef = useRef(getAgentHudEnabled());
  const mainPanelBodyRef = useRef<HTMLDivElement | null>(null);
  const noteDetailScrollRef = useRef<HTMLDivElement | null>(null);
  const notesListRef = useRef<NotesListHandle | null>(null);
  const agentSessionsListRef = useRef<AgentSessionsListHandle | null>(null);
  // Where the back affordance in settings returns to — captured when settings
  // is opened so "back" lands the user where they were, not on Notes.
  const [settingsReturnView, setSettingsReturnView] =
    useState<SidebarView>("notes");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const openSettings = useCallback(() => {
    const returnView = activeViewRef.current;
    if (returnView !== "settings") {
      setSettingsReturnView(returnView);
    }
    setActiveView("settings");
  }, []);
  const [originFolderId, setOriginFolderId] = useState<string | undefined>();
  // Tracks that the open note was drilled into from the All notes view, so the
  // note shows the same back-arrow + breadcrumb chrome folders use. Cleared
  // whenever a note is opened from anywhere else (e.g. the sidebar list).
  const [originAllNotes, setOriginAllNotes] = useState(false);
  const [folderReturnTarget, setFolderReturnTarget] = useState<
    { noteId: string; label: string } | undefined
  >();
  const [moveDialogNoteIds, setMoveDialogNoteIds] = useState<string[] | null>(
    null,
  );
  // User's intent for system audio. Defaults true ("record everything").
  // The actual sourceMode is derived below so that granting/revoking
  // permission in System Settings flips the toggle without losing intent.
  const [userWantsSystemAudio, setUserWantsSystemAudio] = useState(true);
  const [sourceReadiness, setSourceReadiness] =
    useState<RecordingSourceReadinessDto>();
  const [checkingSourceReadiness, setCheckingSourceReadiness] = useState(false);
  const [accessibilityStatus, setAccessibilityStatus] = useState<string>();
  const [accessibilityRefreshRequest, setAccessibilityRefreshRequest] =
    useState(0);
  const [microphoneStatus, setMicrophoneStatus] = useState<string>();
  const [readyUpdate, setReadyUpdate] =
    useState<UpdatePromptPayload<ScribeUpdate> | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [preparingUpdate, setPreparingUpdate] = useState(false);
  const [relaunchingUpdate, setRelaunchingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] =
    useState<UpdateInstallProgress | null>(null);
  const systemGranted = !!sourceReadiness?.sources.find(
    (source) => source.source === "system",
  )?.ready;
  const sourceMode: RecordingSourceMode =
    userWantsSystemAudio && systemGranted
      ? "microphonePlusSystem"
      : "microphoneOnly";
  const {
    account,
    error: accountError,
    loading: accountLoading,
    refresh: refreshAccount,
    setAccount,
  } = useAccountStatus({ forceLogoutOnMount: replayOnboarding });
  // The note the active recording session belongs to. recordingStatus carries
  // no noteId, so without this the finish flow could only guess from the
  // currently selected note — wrong whenever the user browsed away while
  // recording.
  const recordingNoteIdRef = useRef<string | undefined>(undefined);
  // Reactive mirror of recordingNoteIdRef. The ref serves the async finish/HUD
  // paths that need the latest value synchronously; this state drives render
  // decisions — which note shows the in-note RecorderBar, and whether the
  // floating global recorder pill is up (it shows whenever a recording is live
  // but you're not viewing its note). Always update them together via
  // setRecordingNote so they can't drift.
  const [recordingNoteId, setRecordingNoteIdState] = useState<
    string | undefined
  >(undefined);
  const recordingStatusRef = useRef(state.recordingStatus);
  const recordingInactivityTrackerRef = useRef<RecordingInactivityTracker>({});
  const [recordingInactivityPrompt, setRecordingInactivityPrompt] =
    useState<RecordingInactivityPrompt | null>(null);
  const [recordingInactivityNow, setRecordingInactivityNow] = useState(() =>
    Date.now(),
  );
  const recordingStartInFlightRef = useRef(false);
  const [liveTranscriptEvents, setLiveTranscriptEvents] = useState<
    LiveTranscriptEventDto[]
  >([]);
  useEffect(() => {
    recordingStatusRef.current = state.recordingStatus;
  }, [state.recordingStatus]);
  const setRecordingNote = useCallback((noteId: string | undefined) => {
    recordingNoteIdRef.current = noteId;
    setRecordingNoteIdState(noteId);
  }, []);
  // Dev-only synthetic status driving the global recorder pill, set by the
  // window.__globalRecorderPill console hook. When non-null it force-shows the
  // pill (any view, no real recording) so its styling can be inspected.
  const [demoRecorderStatus, setDemoRecorderStatus] =
    useState<RecordingStatusDto | null>(null);
  const demoRecorderRef = useRef<GlobalRecorderDemoApi | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("../lib/global-recorder-demo").then(
      ({ registerGlobalRecorderDemo }) => {
        if (cancelled) return;
        demoRecorderRef.current = registerGlobalRecorderDemo({
          setStatus: setDemoRecorderStatus,
        });
      },
    );
    return () => {
      cancelled = true;
      demoRecorderRef.current?.dispose();
      demoRecorderRef.current = null;
    };
  }, []);
  // Sessions with a finishRecording call in flight; guards stop double-clicks.
  const finishingSessionsRef = useRef<Set<string>>(new Set());
  // A dev build without the OS Accounts env vars (fresh workspace, no .env)
  // can never complete sign-in, so the sign-in and trial gates would be dead
  // ends — skip them and let account-dependent features surface their own
  // errors. Release builds always gate; so do dev builds once configured.
  const devAccountsUnconfigured =
    import.meta.env.DEV &&
    !account.signedIn &&
    (accountLoading || !!accountError || !account.configured);
  const signInRequired =
    !devAccountsUnconfigured && shouldBlockOnSignIn(account);
  const trialRequired =
    !devAccountsUnconfigured && !signInRequired && shouldBlockOnTrial(account);
  const [onboardingDone, setOnboardingDone] = useState(() => {
    applyOnboardingReplayFlag();
    return isOnboardingComplete();
  });
  // The wizard handles sign-in and the free trial itself, so it gates on
  // onboarding state alone; AccountGate/TrialGate remain for users who
  // finished onboarding and later signed out or lapsed.
  const onboardingRequired = !accountLoading && !onboardingDone;
  // Onboarding counts as blocked so bootstrap, update checks, and the eager
  // permission probes hold off until the wizard finishes — the wizard owns
  // the permission prompts while it's on screen.
  const appBlocked =
    accountLoading || signInRequired || trialRequired || onboardingRequired;
  const publishAgentMenuBarState = useCallback(() => {
    void emitAgentMenuBarState(
      buildAgentMenuBarState({
        sessions: agentMenuBarSessionsRef.current,
        workingSessionIds: agentMenuBarWorkingSessionIdsRef.current,
        waitingSessionIds: agentMenuBarWaitingSessionIdsRef.current,
        lastStatus: agentMenuBarLastStatusRef.current,
        agentHudEnabled: agentHudEnabledRef.current,
        limit: AGENT_MENU_BAR_SESSION_LIMIT,
      }),
    );
  }, []);
  const applyAgentHudVisibility = useCallback(
    (enabled: boolean) => {
      if (agentHudEnabledRef.current === enabled) return;
      agentHudEnabledRef.current = enabled;
      publishAgentMenuBarState();
    },
    [publishAgentMenuBarState],
  );
  const handleAgentHudVisibilityRequest = useCallback((enabled: boolean) => {
    setAgentHudEnabled(enabled);
    void (enabled ? agentHudShow() : agentHudHide()).catch((err) => {
      setError(messageFromError(err));
    });
  }, []);
  const selectedNote = state.selectedNote;
  const selectedNoteId = selectedNote?.id;
  const originFolder = originFolderId
    ? state.folders.find((folder) => folder.id === originFolderId)
    : undefined;
  const agentOriginFolder =
    agentOrigin?.kind === "project"
      ? state.folders.find((folder) => folder.id === agentOrigin.folderId)
      : undefined;
  const recoveriesByNote = useMemo(() => {
    const map = new Map<string, (typeof state.activeRecoveries)[number]>();
    for (const recovery of state.activeRecoveries) {
      // If multiple recoveries land on one note, the first one wins —
      // backend should only surface one per note in practice.
      if (!map.has(recovery.noteId)) map.set(recovery.noteId, recovery);
    }
    return map;
  }, [state.activeRecoveries]);
  const recoverableNoteIds = useMemo(
    () => new Set(recoveriesByNote.keys()),
    [recoveriesByNote],
  );
  const selectedRecovery = selectedNote
    ? recoveriesByNote.get(selectedNote.id)
    : undefined;
  const noteDetailScrollerActive = activeView === "meetings" && !!selectedNote;
  const noteHasBreadcrumb = !!(originFolder || originAllNotes);
  const detailScrollerActive =
    activeView === "folders" && !!state.selectedFolderId;

  // ---- Tabs ------------------------------------------------------------
  // The current live navigation, reduced to a snapshot. Fields are gated by
  // view so the active tab only churns when something it actually shows
  // changes (see navEquals).
  const liveNav = useMemo<TabNav>(
    () => ({
      view: activeView,
      noteId: activeView === "meetings" ? selectedNoteId : undefined,
      originFolderId: activeView === "meetings" ? originFolderId : undefined,
      originAllNotes: activeView === "meetings" ? originAllNotes : undefined,
      folderId: activeView === "folders" ? state.selectedFolderId : undefined,
      agentSessionId:
        activeView === "agent" ? activeAgentSession?.id : undefined,
      agentOrigin: activeView === "agent" ? agentOrigin : undefined,
    }),
    [
      activeView,
      selectedNoteId,
      originFolderId,
      originAllNotes,
      state.selectedFolderId,
      activeAgentSession?.id,
      agentOrigin,
    ],
  );

  // Mirror live navigation into the active tab. While a restore is in flight we
  // hold off until live nav settles onto the target, then release — this keeps
  // an async note load mid-switch from stamping a half-built snapshot onto the
  // tab we're moving to.
  useEffect(() => {
    if (restoreTargetRef.current) {
      if (navEquals(restoreTargetRef.current, liveNav)) {
        restoreTargetRef.current = null;
      }
      return;
    }
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === activeTabId && !navEquals(tab.nav, liveNav)
          ? { ...tab, nav: liveNav }
          : tab,
      ),
    );
  }, [liveNav, activeTabId]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Keep the latest selected note id reachable from applyNav without making it
  // a dependency (which would rebuild the callback on every note change).
  const selectedNoteIdRef = useRef(selectedNoteId);
  useEffect(() => {
    selectedNoteIdRef.current = selectedNoteId;
  }, [selectedNoteId]);

  // Push a snapshot into live state. Used by tab switch / open only; in-tab
  // navigation keeps flowing through the existing handlers untouched.
  const applyNav = useCallback(
    (nav: TabNav) => {
      // The guard only needs to bridge the async note fetch — everything else
      // applies synchronously. So hold capture only while a fetch is in flight
      // and release it when the fetch settles (success or failure), never tying
      // release to a target that might be unreachable (a deleted session/note).
      restoreTargetRef.current = nav;
      setAgentOrigin(nav.view === "agent" ? nav.agentOrigin : undefined);
      setOriginFolderId(
        nav.view === "meetings" ? nav.originFolderId : undefined,
      );
      setOriginAllNotes(nav.view === "meetings" ? !!nav.originAllNotes : false);
      // The "back to <note>" breadcrumb target isn't part of a tab's snapshot,
      // so clear it on every restore — otherwise it leaks from the tab that set
      // it into whatever tab we switch to.
      setFolderReturnTarget(undefined);
      if (nav.view === "folders") {
        dispatch({ type: "folderSelected", folderId: nav.folderId });
      }
      // Mirror openSettings: a settings tab (e.g. cmd-clicked open) needs a
      // return view recorded so exiting Settings lands where it came from.
      if (nav.view === "settings") {
        const returnView = activeViewRef.current;
        if (returnView !== "settings") setSettingsReturnView(returnView);
      }
      if (nav.view === "agent") {
        const session = nav.agentSessionId
          ? agentSessions.find((s) => s.id === nav.agentSessionId)
          : undefined;
        setActiveAgentSession(session);
      } else {
        setActiveAgentSession(undefined);
      }
      const needsNoteLoad =
        nav.view === "meetings" &&
        !!nav.noteId &&
        selectedNoteIdRef.current !== nav.noteId;
      if (needsNoteLoad) {
        const noteId = nav.noteId!;
        void getNote(noteId)
          .then((note) => dispatch({ type: "noteLoaded", note }))
          .catch((err: unknown) => setError(messageFromError(err)))
          .finally(() => {
            // A newer restore may have superseded this one — only release the
            // guard if it's still ours.
            if (restoreTargetRef.current === nav) {
              restoreTargetRef.current = null;
            }
          });
      } else {
        // Nothing async to wait for — let capture resume immediately.
        restoreTargetRef.current = null;
      }
      setActiveView(nav.view);
    },
    [agentSessions],
  );
  const applyNavRef = useRef(applyNav);
  useEffect(() => {
    applyNavRef.current = applyNav;
  }, [applyNav]);

  function activateTab(id: string) {
    if (id === activeTabId) return;
    const target = tabs.find((tab) => tab.id === id);
    if (!target) return;
    setActiveTabId(id);
    applyNav(target.nav);
  }

  // Open a fresh tab on the given snapshot and focus it. The active tab's own
  // snapshot was already captured by the mirror effect, so nothing is lost.
  function openTab(nav: TabNav) {
    const id = makeTabId();
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = [...tabs];
    // Drop the new tab in just to the right of the active one, like a browser.
    next.splice(index < 0 ? tabs.length : index + 1, 0, { id, nav });
    setTabs(next);
    setActiveTabId(id);
    applyNav(nav);
  }

  // Drive live state to a brand-new chat: arm the new-session handshake so the
  // agent workspace opens on the hero instead of restoring the last
  // conversation. Mirrors handleNewAgentSession (applyNav alone would only swap
  // state, leaving the previous chat on screen under a "New chat" label).
  const armNewChatLive = useCallback(() => {
    restoreTargetRef.current = { view: "agent" };
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    markAgentNewSessionPending();
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT),
      );
    }, 0);
  }, []);

  // The "+" / ⌘T affordance: a new tab is always a fresh chat.
  function openNewChatTab() {
    const id = makeTabId();
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = [...tabs];
    next.splice(index < 0 ? tabs.length : index + 1, 0, {
      id,
      nav: defaultNav(),
    });
    setTabs(next);
    setActiveTabId(id);
    armNewChatLive();
  }

  const closeTab = useCallback(
    (id: string) => {
      const currentTabs = tabsRef.current;
      const currentActiveTabId = activeTabIdRef.current;

      if (currentTabs.length <= 1) {
        // Never leave the strip empty — reset the sole tab to a fresh chat.
        const fresh = { id: makeTabId(), nav: defaultNav() };
        tabsRef.current = [fresh];
        activeTabIdRef.current = fresh.id;
        setTabs([fresh]);
        setActiveTabId(fresh.id);
        armNewChatLive();
        return;
      }
      const index = currentTabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const next = currentTabs.filter((tab) => tab.id !== id);
      tabsRef.current = next;
      setTabs(next);
      if (id === currentActiveTabId) {
        // Focus the right neighbor, falling back to the left — browser behavior.
        const neighbor = next[index] ?? next[index - 1];
        if (neighbor) {
          activeTabIdRef.current = neighbor.id;
          setActiveTabId(neighbor.id);
          applyNavRef.current(neighbor.nav);
        }
      }
    },
    [armNewChatLive],
  );

  // Keep only the given tab, focusing it. From the tab right-click menu.
  function closeOtherTabs(id: string) {
    const keep = tabs.find((tab) => tab.id === id);
    if (!keep || tabs.length <= 1) return;
    setTabs([keep]);
    if (id !== activeTabId) {
      setActiveTabId(id);
      applyNav(keep.nav);
    }
  }

  function cycleTab(delta: number) {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    if (index < 0) return;
    const target = tabs[(index + delta + tabs.length) % tabs.length];
    if (target) activateTab(target.id);
  }

  // Drop tabs whose note was deleted. The active tab is kept regardless: the
  // delete handlers already move its selection on to the next note, and the
  // capture effect reconciles its snapshot — pruning it here would fight that.
  function pruneDeletedNoteTabs(removedIds: Set<string>) {
    setTabs((prev) =>
      prev.filter(
        (tab) =>
          tab.id === activeTabId ||
          !(
            tab.nav.view === "meetings" &&
            tab.nav.noteId &&
            removedIds.has(tab.nav.noteId)
          ),
      ),
    );
  }

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen(CLOSE_TAB_EVENT, () => {
      if (document.querySelector('[role="dialog"]')) return;
      closeTab(activeTabIdRef.current);
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [closeTab]);

  // Tab keyboard shortcuts: ⌘T new, ⌘W close, ⌘[ / ⌘] cycle, ⌘1-9 jump
  // (9 = last).
  // isPrimaryShortcut handles the cross-platform modifier (⌘ on mac, Ctrl on
  // Windows) and rejects Alt/Shift. No dependency array — re-bound each render
  // so it closes over current tabs, matching the search/new-note effects below.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isPrimaryShortcut(event)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const key = event.key;
      if (key.toLowerCase() === "t") {
        event.preventDefault();
        openNewChatTab();
        return;
      }
      if (key.toLowerCase() === "w") {
        event.preventDefault();
        closeTab(activeTabId);
        return;
      }
      if (key === "]" || key === "}") {
        event.preventDefault();
        cycleTab(1);
        return;
      }
      if (key === "[" || key === "{") {
        event.preventDefault();
        cycleTab(-1);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        event.preventDefault();
        const n = Number(key);
        const target = n >= tabs.length ? tabs[tabs.length - 1] : tabs[n - 1];
        if (target) activateTab(target.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Modifier state for the click that's about to fire a navigation. A
  // capture-phase listener records it before React's bubble-phase handlers run,
  // so any nav surface (sidebar, notes list, command palette) can open in a new
  // tab via ⌘/Ctrl-click or middle-click without threading flags through props.
  const newTabIntentRef = useRef(false);
  useEffect(() => {
    const record = (event: MouseEvent) => {
      newTabIntentRef.current =
        event.metaKey || event.ctrlKey || event.button === 1;
    };
    window.addEventListener("click", record, true);
    window.addEventListener("auxclick", record, true);
    return () => {
      window.removeEventListener("click", record, true);
      window.removeEventListener("auxclick", record, true);
    };
  }, []);
  // Reads and clears the intent: true when the triggering click wanted a new tab.
  const takeNewTabIntent = useCallback(() => {
    const intent = newTabIntentRef.current;
    newTabIntentRef.current = false;
    return intent;
  }, []);

  const tabItems = useMemo<TabItem[]>(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        ...tabMeta(tab.nav, state.notes, state.folders, agentSessions),
      })),
    [tabs, state.notes, state.folders, agentSessions],
  );

  function handleRecovery(sessionId: string, action: "validate" | "discard") {
    const recoveryNoteId = state.activeRecoveries.find(
      (recovery) => recovery.sessionId === sessionId,
    )?.noteId;
    void (async () => {
      try {
        const note = await recoverRecording(sessionId, action);
        clearActiveRecordingSession(sessionId);
        dispatch({ type: "noteProcessingUpdated", note });
        dispatch({ type: "recoveryRemoved", sessionId });
      } catch (err) {
        if (
          action === "validate" &&
          recoveryNoteId &&
          (await applyNoteScopedProcessingFailure(recoveryNoteId, err))
        ) {
          clearActiveRecordingSession(sessionId);
          dispatch({ type: "recoveryRemoved", sessionId });
          return;
        }
        setError(messageFromError(err));
      }
    })();
  }

  function clearActiveRecordingSession(sessionId: string) {
    if (recordingStatusRef.current?.sessionId !== sessionId) return;
    recordingStatusRef.current = undefined;
    setRecordingNote(undefined);
    dispatch({ type: "recordingStatusCleared" });
  }

  const handleAccountChanged = useCallback(
    (nextAccount: AccountStatus) => {
      if (signInRequired && !shouldBlockOnSignIn(nextAccount)) {
        // The launch handshake armed at state init has likely expired (15s
        // TTL) while the user sat on the sign-in gate — re-arm it so clearing
        // the gate still opens onto a fresh session.
        markAgentNewSessionPending();
      }
      setAccount(nextAccount);
    },
    [setAccount, signInRequired],
  );

  // Log out from the sidebar identity popover. Dropping the session flips
  // shouldBlockOnSignIn back on, so the app falls through to the AccountGate.
  async function handleSignOut() {
    try {
      await osAccountsLogout();
      handleAccountChanged({ signedIn: false, configured: account.configured });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  useEffect(() => {
    preloadRecordingSounds();
  }, []);

  // The card scroller's thumb fades in with scroll/pointer activity and back
  // out when idle (native-overlay feel; see scroll-thumb-fade.ts).
  useEffect(() => {
    const el = mainPanelBodyRef.current;
    if (!el) return;
    return attachScrollThumbFade(el);
  }, []);

  useEffect(() => {
    if (!noteDetailScrollerActive) return;
    const el = noteDetailScrollRef.current;
    if (!el) return;
    return attachScrollThumbFade(el);
  }, [noteDetailScrollerActive, selectedNoteId]);

  // Update state is read through refs so runUpdateCheck keeps a stable identity.
  // Otherwise the launch effect and the manual-check listener below would tear
  // down and re-fire every time a download or relaunch toggles state.
  const preparingUpdateRef = useRef(false);
  const checkingUpdateRef = useRef(false);
  const readyUpdateRef = useRef<UpdatePromptPayload<ScribeUpdate> | null>(null);
  const relaunchingUpdateRef = useRef(false);
  const updateProgressHiddenRef = useRef(false);
  useEffect(() => {
    preparingUpdateRef.current = preparingUpdate;
  }, [preparingUpdate]);
  useEffect(() => {
    readyUpdateRef.current = readyUpdate;
  }, [readyUpdate]);
  useEffect(() => {
    relaunchingUpdateRef.current = relaunchingUpdate;
  }, [relaunchingUpdate]);

  const prepareUpdate = useCallback(
    (payload: UpdatePromptPayload<ScribeUpdate>, mode: UpdateCheckMode) => {
      if (
        preparingUpdateRef.current ||
        readyUpdateRef.current ||
        relaunchingUpdateRef.current
      ) {
        return;
      }

      preparingUpdateRef.current = true;
      updateProgressHiddenRef.current = false;
      setPreparingUpdate(true);
      setReadyUpdate(null);
      setUpdateProgress(null);
      setUpdateStatus(mode === "manual" ? "Downloading update..." : null);

      void prepareScribeUpdate({
        update: payload.update,
        reportProgress: (progress) => {
          setUpdateProgress(progress);
          if (mode === "manual" && !updateProgressHiddenRef.current) {
            setUpdateStatus(
              progress.state === "installing"
                ? "Preparing update..."
                : "Downloading update...",
            );
          }
        },
        reportReady: (ready) => {
          preparingUpdateRef.current = false;
          readyUpdateRef.current = ready;
          updateProgressHiddenRef.current = false;
          setPreparingUpdate(false);
          setReadyUpdate(ready);
          setUpdateProgress(null);
          setUpdateStatus(null);
        },
        reportFailure: (message) => {
          preparingUpdateRef.current = false;
          updateProgressHiddenRef.current = false;
          setPreparingUpdate(false);
          setUpdateProgress(null);
          setUpdateStatus(`Update failed: ${message}`);
        },
      });
    },
    [],
  );

  const runUpdateCheck = useCallback(
    (mode: UpdateCheckMode) => {
      if (readyUpdateRef.current || relaunchingUpdateRef.current) return;
      if (checkingUpdateRef.current) return;
      if (preparingUpdateRef.current) {
        if (mode === "manual") {
          updateProgressHiddenRef.current = false;
          setUpdateStatus("Downloading update...");
        }
        return;
      }
      checkingUpdateRef.current = true;
      if (mode === "manual") setUpdateStatus("Checking for updates...");
      else if (mode === "launch") setUpdateStatus(null);
      void checkForScribeUpdate(
        {
          check: checkScribeUpdate,
          prompt: (payload) => {
            prepareUpdate(payload, mode);
          },
          reportNoUpdate: () => setUpdateStatus("June is up to date."),
          reportFailure: (message) => {
            if (mode !== "periodic") {
              setUpdateStatus(`Update check failed: ${message}`);
            }
          },
        },
        mode,
      ).finally(() => {
        checkingUpdateRef.current = false;
      });
    },
    [prepareUpdate],
  );

  const handleRelaunchUpdate = useCallback(() => {
    if (!readyUpdateRef.current || relaunchingUpdateRef.current) return;
    relaunchingUpdateRef.current = true;
    setRelaunchingUpdate(true);
    setUpdateStatus(null);
    void relaunchScribe().catch((error) => {
      relaunchingUpdateRef.current = false;
      setRelaunchingUpdate(false);
      setUpdateStatus(`Relaunch failed: ${messageFromError(error)}`);
    });
  }, []);

  // Launch check: silent by design — a "no update" result shows nothing so it
  // never interrupts the user (PRD user story 7) — and fired at most once per
  // session, so a later install toggle can't re-trigger it.
  const launchCheckedRef = useRef(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (appBlocked || launchCheckedRef.current) return;
    launchCheckedRef.current = true;
    runUpdateCheck("launch");
  }, [appBlocked, runUpdateCheck]);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (appBlocked) return;
    return startPeriodicScribeUpdateChecks(runUpdateCheck);
  }, [appBlocked, runUpdateCheck]);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen(CHECK_FOR_UPDATES_EVENT, () => runUpdateCheck("manual")).then(
      (cleanup) => {
        if (aborted) cleanup();
        else unlisten = cleanup;
      },
    );
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [runUpdateCheck]);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen(OPEN_SETTINGS_EVENT, openSettings).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [openSettings]);

  useEffect(() => {
    function openAgentWorkspace(session?: HermesSessionInfo) {
      setAgentOrigin(undefined);
      setActiveAgentSession(session);
      setActiveView("agent");
    }

    function handleOpenEvent(event: Event) {
      const detail = (event as CustomEvent<{ session?: HermesSessionInfo }>)
        .detail;
      openAgentWorkspace(detail?.session);
    }

    let aborted = false;
    let unlisten: (() => void) | undefined;
    window.addEventListener(AGENT_OPEN_EVENT, handleOpenEvent);
    void listen<{ session?: HermesSessionInfo }>(AGENT_OPEN_EVENT, (event) => {
      openAgentWorkspace(event.payload?.session);
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      aborted = true;
      unlisten?.();
      window.removeEventListener(AGENT_OPEN_EVENT, handleOpenEvent);
    };
  }, []);

  useEffect(() => {
    const handleAgentStatus = (event: Event) => {
      const detail = (event as CustomEvent<AgentSessionStatusDetail>).detail;
      if (!detail) return;
      void notifyAgentSessionStatus(detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleAgentStatus);
    return () => {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleAgentStatus);
    };
  }, []);

  useEffect(() => {
    publishAgentMenuBarState();
  }, [publishAgentMenuBarState]);

  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    let cancelled = false;
    let retryTimeout: number | undefined;

    function loadAgentMenuBarSessions(attempt: number) {
      listHermesSessions({ limit: AGENT_MENU_BAR_SESSION_FETCH_LIMIT })
        .then((sessions) => {
          if (cancelled) return;
          agentMenuBarSessionsRef.current = sessions;
          setAgentSessions(sessions);
          publishAgentMenuBarState();
        })
        .catch(() => {
          if (cancelled) return;
          const retryDelay = AGENT_MENU_BAR_SESSION_RETRY_DELAYS_MS[attempt];
          if (retryDelay == null) return;
          retryTimeout = window.setTimeout(
            () => loadAgentMenuBarSessions(attempt + 1),
            retryDelay,
          );
        });
    }

    loadAgentMenuBarSessions(0);

    return () => {
      cancelled = true;
      if (retryTimeout != null) {
        window.clearTimeout(retryTimeout);
      }
    };
  }, [appBlocked, bootstrapped, publishAgentMenuBarState]);

  // Project assignments for agent sessions, loaded once storage is up.
  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    let cancelled = false;
    void listSessionFolders()
      .then((assignments) => {
        if (cancelled) return;
        const next: Record<string, string[]> = {};
        for (const assignment of assignments) {
          (next[assignment.sessionId] ??= []).push(assignment.folderId);
        }
        setSessionFolders(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [appBlocked, bootstrapped]);

  useEffect(() => {
    function handleSessionsChanged(event: Event) {
      const detail = (event as CustomEvent<AgentSessionsChangedDetail>).detail;
      if (!detail) return;
      agentMenuBarSessionsRef.current = detail.sessions;
      setAgentSessions(detail.sessions);
      // "New session" started from a project: file the first brand-new
      // session that gets selected; switching to a known session instead
      // abandons the intent.
      const pendingProject = pendingSessionProjectRef.current;
      if (pendingProject && detail.selectedSessionId) {
        pendingSessionProjectRef.current = null;
        const sessionId = detail.selectedSessionId;
        if (!pendingProject.knownSessionIds.has(sessionId)) {
          void assignSessionToFolder(sessionId, pendingProject.folderId)
            .then(() =>
              setSessionFolders((prev) => ({
                ...prev,
                [sessionId]: [pendingProject.folderId],
              })),
            )
            .catch(() => {});
        } else {
          // User switched to an existing session — abandon the pending
          // project intent so the workspace doesn't show misleading crumbs.
          setAgentOrigin(undefined);
        }
      }
      const nextWorkingSessionIds = new Set(detail.workingSessionIds);
      const nextWaitingSessionIds = new Set(detail.waitingSessionIds ?? []);
      agentMenuBarWorkingSessionIdsRef.current = nextWorkingSessionIds;
      agentMenuBarWaitingSessionIdsRef.current = nextWaitingSessionIds;
      setAgentWorkingSessionIds(new Set(nextWorkingSessionIds));
      setAgentWaitingSessionIds(new Set(nextWaitingSessionIds));
      publishAgentMenuBarState();
    }

    function handleAgentStatusForMenuBar(event: Event) {
      const detail = (event as CustomEvent<AgentSessionStatusDetail>).detail;
      if (!detail) return;
      agentMenuBarLastStatusRef.current = detail;
      if (detail.sessionId) {
        updateMenuBarSessionStatus(detail.sessionId, detail.status, {
          working: agentMenuBarWorkingSessionIdsRef.current,
          waiting: agentMenuBarWaitingSessionIdsRef.current,
        });
        setAgentWorkingSessionIds(
          new Set(agentMenuBarWorkingSessionIdsRef.current),
        );
        setAgentWaitingSessionIds(
          new Set(agentMenuBarWaitingSessionIdsRef.current),
        );
      }
      publishAgentMenuBarState();
    }

    function handleAgentSessionDeleted(event: Event) {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      agentMenuBarSessionsRef.current = agentMenuBarSessionsRef.current.filter(
        (session) => session.id !== sessionId,
      );
      setAgentSessions((current) =>
        current.filter((session) => session.id !== sessionId),
      );
      agentMenuBarWorkingSessionIdsRef.current.delete(sessionId);
      agentMenuBarWaitingSessionIdsRef.current.delete(sessionId);
      setAgentWorkingSessionIds(
        new Set(agentMenuBarWorkingSessionIdsRef.current),
      );
      setAgentWaitingSessionIds(
        new Set(agentMenuBarWaitingSessionIdsRef.current),
      );
      publishAgentMenuBarState();
    }

    window.addEventListener(
      AGENT_SESSIONS_CHANGED_EVENT,
      handleSessionsChanged,
    );
    window.addEventListener(
      AGENT_SESSION_STATUS_EVENT,
      handleAgentStatusForMenuBar,
    );
    window.addEventListener(
      AGENT_DELETE_SESSION_EVENT,
      handleAgentSessionDeleted,
    );
    return () => {
      window.removeEventListener(
        AGENT_SESSIONS_CHANGED_EVENT,
        handleSessionsChanged,
      );
      window.removeEventListener(
        AGENT_SESSION_STATUS_EVENT,
        handleAgentStatusForMenuBar,
      );
      window.removeEventListener(
        AGENT_DELETE_SESSION_EVENT,
        handleAgentSessionDeleted,
      );
    };
  }, [publishAgentMenuBarState]);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;

    function handleVisibilityChanged(event: Event) {
      const detail = (event as CustomEvent<AgentHudVisibilityChangedDetail>)
        .detail;
      if (detail) applyAgentHudVisibility(detail.enabled);
    }

    window.addEventListener(
      AGENT_HUD_VISIBILITY_CHANGED_EVENT,
      handleVisibilityChanged,
    );
    void listen<AgentHudVisibilityChangedDetail>(
      AGENT_HUD_VISIBILITY_CHANGED_EVENT,
      (event) => applyAgentHudVisibility(event.payload.enabled),
    )
      .then((cleanup) => {
        if (aborted) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {
        // Native HUD visibility events only exist inside the Tauri shell.
      });

    return () => {
      aborted = true;
      unlisten?.();
      window.removeEventListener(
        AGENT_HUD_VISIBILITY_CHANGED_EVENT,
        handleVisibilityChanged,
      );
    };
  }, [applyAgentHudVisibility]);

  useEffect(() => {
    let aborted = false;
    const unlisteners: Array<() => void> = [];

    async function installMenuBarListener<T>(
      eventName: string,
      handler: (payload: T) => void,
    ) {
      try {
        const cleanup = await listen<T>(eventName, (event) =>
          handler(event.payload),
        );
        if (aborted) cleanup();
        else unlisteners.push(cleanup);
      } catch {
        // Native menu-bar events only exist inside the Tauri shell.
      }
    }

    void installMenuBarListener<void>(AGENT_MENU_BAR_NEW_SESSION_EVENT, () => {
      pendingSessionProjectRef.current = null;
      setAgentOrigin(undefined);
      markAgentNewSessionPending();
      setActiveAgentSession(undefined);
      setActiveView("agent");
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT),
        );
      }, 0);
    });

    void installMenuBarListener<string>(
      AGENT_MENU_BAR_OPEN_SESSION_EVENT,
      (sessionId) => {
        setAgentOrigin(undefined);
        if (!sessionId) {
          setActiveView("agent");
          return;
        }
        const cachedSession = agentMenuBarSessionsRef.current.find(
          (session) => session.id === sessionId,
        );
        if (cachedSession) {
          setActiveAgentSession(cachedSession);
          setActiveView("agent");
          return;
        }
        void listHermesSessions({ limit: 100 })
          .then((sessions) => {
            agentMenuBarSessionsRef.current = sessions;
            const session = sessions.find((item) => item.id === sessionId);
            if (session) setActiveAgentSession(session);
            setActiveView("agent");
            publishAgentMenuBarState();
          })
          .catch(() => {
            setActiveView("agent");
          });
      },
    );

    void installMenuBarListener<boolean>(
      AGENT_MENU_BAR_SET_AGENT_HUD_EVENT,
      handleAgentHudVisibilityRequest,
    );

    return () => {
      aborted = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [handleAgentHudVisibilityRequest, publishAgentMenuBarState]);

  // Dev-tools response gallery (window.__agentGallery): showing it jumps to the
  // Agent view so the command works no matter which view is active.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onGallery = (event: Event) => {
      const detail = (event as CustomEvent<AgentGalleryDetail>).detail;
      if (detail?.show) setActiveView("agent");
    };
    window.addEventListener(AGENT_GALLERY_EVENT, onGallery);
    return () => window.removeEventListener(AGENT_GALLERY_EVENT, onGallery);
  }, []);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationHelperEvent(event.payload);
      if (!helperEvent) return;
      if (helperEvent.type === "agent_session_prompt") {
        const prompt = stringPayloadValue(helperEvent.payload?.prompt) ?? "";
        dispatchAgentSessionStatus({
          prompt,
          title: titleFromPrompt(prompt),
          status: "received",
          summary: "June is starting.",
        });
        markAgentNewSessionPending(prompt);
        setActiveView("agent");
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT, {
              detail: { prompt },
            }),
          );
        }, 0);
        return;
      }
      if (
        helperEvent.type !== "permission_status" &&
        helperEvent.type !== "dictation_diagnostics"
      ) {
        return;
      }
      const microphone = stringPayloadValue(helperEvent.payload?.microphone);
      const accessibility = stringPayloadValue(
        helperEvent.payload?.accessibility,
      );
      if (microphone) setMicrophoneStatus(microphone);
      if (accessibility) setAccessibilityStatus(accessibility);
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  // The detached meeting HUD (shown when June is backgrounded, minimized, or
  // hidden mid-recording) is a presence indicator, not a control surface:
  // clicking it emits "reopen", and we bring the window forward and land back
  // on the meeting being recorded. All recording controls stay in-app.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let aborted = false;
    void listen<{ action: "reopen"; noteId?: string }>(
      "meeting-hud-action",
      (event) => {
        if (event.payload?.action !== "reopen") return;
        const main = getCurrentWindow();
        void main.show();
        void main.unminimize();
        void main.setFocus();
        const noteId = event.payload.noteId ?? recordingNoteIdRef.current;
        if (noteId) {
          setActiveView("meetings");
          void handleSelectNote(noteId);
        }
      },
    ).then((cleanup) => {
      // If the listener resolves after unmount, tear it down immediately.
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  const accessibilityBlocked = isAccessibilityBlocked(accessibilityStatus);
  // The Rust readiness check probes mic via cpal, which doesn't reflect
  // TCC denial. Trust the dictation helper's AVCaptureDevice status
  // instead — that's the authoritative macOS API for the mic privacy
  // entry.
  const microphoneBlocked = isDeniedPermission(microphoneStatus);

  useEffect(() => {
    if (appBlocked) return;
    bootstrapApp()
      .then(async (payload) => {
        const seeded = withFakeRecovery(payload);
        dispatch({ type: "bootstrapLoaded", payload: seeded.payload });
        if (seeded.fakeNote) {
          dispatch({ type: "noteLoaded", note: seeded.fakeNote });
          // The fake-recovery dev flow inspects the notes list, so it skips
          // the agent landing.
          setActiveView("notes");
          setBootstrapped(true);
          return;
        }
        // The app lands on the agent view, but a note is still selected
        // up-front: the menu-bar meeting-start event records into the
        // selected note without any further user input.
        if (seeded.payload.notes.length === 0) {
          const note = await createNote(undefined);
          dispatch({ type: "noteLoaded", note });
          setBootstrapped(true);
          return;
        }
        const firstNoteId = seeded.payload.notes[0]?.id;
        if (firstNoteId) {
          const note = await getNote(firstNoteId);
          dispatch({ type: "noteLoaded", note });
        }
        setBootstrapped(true);
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [appBlocked]);

  // Probe with "microphonePlusSystem" on mount so sourceReadiness always
  // has the system source. Onboarding's permissions screen normally fires
  // the native TCC prompt in context; for users who skipped that step the
  // helper preflight behind this call surfaces it here instead.
  useEffect(() => {
    if (appBlocked) return;
    let cancelled = false;
    setCheckingSourceReadiness(true);
    checkRecordingSourceReadiness("microphonePlusSystem")
      .then((readiness) => {
        if (!cancelled) setSourceReadiness(readiness);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      })
      .finally(() => {
        if (!cancelled) setCheckingSourceReadiness(false);
      });
    // Eagerly request mic from the helper. This fires the native TCC
    // prompt for fresh installs (matching the system-audio eager prompt),
    // and for already-denied users it immediately emits the current
    // status so the mic-blocked strip renders without further user
    // action. For granted users it's a no-op.
    void dictationHelperCommand({
      type: "request_microphone_permission",
    }).catch(() => undefined);
    // Check Accessibility on every app open. The helper grant is what lets
    // dictation paste into other apps; without this poll a fresh install
    // never learns the helper is untrusted (the focus refresh below doesn't
    // fire at launch), so the paste-permission banner would stay hidden.
    void dictationHelperCommand({ type: "get_permission_status" }).catch(
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [appBlocked]);

  // Refresh permission state whenever the app regains focus — covers the
  // common case where the user flipped a toggle in System Settings and
  // returns to June. The helper poll is what surfaces fresh mic /
  // accessibility state via the dictation-event listener above.
  useEffect(() => {
    if (appBlocked) return;
    const recordingState = state.recordingStatus?.state;
    const captureActive =
      recordingState === "recording" ||
      recordingState === "paused" ||
      recordingState === "finalizing" ||
      recordingState === "validating";
    function refresh() {
      void dictationHelperCommand({ type: "get_permission_status" }).catch(
        () => undefined,
      );
      if (captureActive) return;
      void checkRecordingSourceReadiness("microphonePlusSystem")
        .then(setSourceReadiness)
        .catch(() => undefined);
    }
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [appBlocked, state.recordingStatus?.state]);

  // After the user asks to grant Accessibility, keep checking briefly while
  // macOS System Settings is in front. This avoids relying on a single webview
  // focus event, which can be missed after the native TCC prompt hands off to
  // System Settings.
  useEffect(() => {
    if (
      appBlocked ||
      !accessibilityBlocked ||
      accessibilityRefreshRequest === 0
    ) {
      return;
    }
    function poll() {
      void dictationHelperCommand({ type: "get_permission_status" }).catch(
        () => undefined,
      );
    }
    poll();
    const interval = window.setInterval(
      poll,
      ACCESSIBILITY_PERMISSION_REFRESH_INTERVAL_MS,
    );
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
    }, ACCESSIBILITY_PERMISSION_REFRESH_TIMEOUT_MS);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [accessibilityBlocked, accessibilityRefreshRequest, appBlocked]);

  function handleSourceModeChange(next: RecordingSourceMode) {
    setUserWantsSystemAudio(next === "microphonePlusSystem");
  }

  // Explicit "Enable" action when system audio is denied. Sets intent on
  // (so the toggle auto-flips ON once permission is granted) and routes
  // the user to the System Settings pane.
  function handleEnableSystemAudio() {
    setUserWantsSystemAudio(true);
    void openPrivacySettings("systemAudio");
  }

  function handleEnableMicrophone() {
    void openPrivacySettings("microphone");
  }

  function handleEnableAccessibility() {
    setAccessibilityRefreshRequest((request) => request + 1);
    void dictationHelperCommand({
      type: "request_accessibility_permission",
    }).catch(() => undefined);
  }

  useEffect(() => {
    if (
      !state.recordingStatus ||
      !["recording", "paused"].includes(state.recordingStatus.state)
    ) {
      return;
    }
    const sessionId = state.recordingStatus.sessionId;
    // Drops in-flight responses once this effect is torn down. Without it, a
    // poll that was already in flight when the user hit stop resolves after
    // recordingStatusCleared and resurrects the recorder bar with a stale
    // status — and since polling for that state never restarts, the bar would
    // be stuck on screen indefinitely.
    let cancelled = false;
    // ~20Hz so the waveform tracks speech as snappily as the dictation HUD
    // (which is event-driven at ~25Hz). The polled equivalent for the recorder;
    // each poll coalesces the peaks since the last one (see Waveform.tsx). Audio
    // is sampled every ~5–10ms in Rust, so there's always a fresh peak waiting;
    // 100ms left the bars a beat behind the voice.
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      getRecordingStatus(sessionId)
        .then((status) => {
          if (!cancelled) dispatch({ type: "recordingStatusChanged", status });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (isAppErrorCode(err, "recording_not_found")) {
            // The backend no longer tracks this session — clear the bar
            // instead of polling a dead session forever. The reducer ignores
            // this if a newer session already replaced it.
            dispatch({ type: "recordingSessionLost", sessionId });
            return;
          }
          setError(messageFromError(err));
        })
        .finally(() => {
          inFlight = false;
        });
    }, 50);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [state.recordingStatus?.sessionId, state.recordingStatus?.state]);

  useEffect(() => {
    if (!state.recordingStatus) {
      setLiveTranscriptEvents([]);
    }
  }, [state.recordingStatus?.sessionId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let aborted = false;
    void listen<LiveTranscriptEventDto>(LIVE_TRANSCRIPT_EVENT, (event) => {
      const payload = event.payload;
      const activeRecording = recordingStatusRef.current;
      if (!activeRecording || payload.sessionId !== activeRecording.sessionId) {
        return;
      }
      if (
        recordingNoteIdRef.current &&
        payload.noteId !== recordingNoteIdRef.current
      ) {
        return;
      }
      const text = payload.text.trim();
      if (!text) return;
      setLiveTranscriptEvents((current) =>
        upsertLiveTranscriptEvent(current, { ...payload, text }),
      );
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (
      !selectedNote ||
      !shouldPollProcessingStatus(selectedNote.processingStatus)
    ) {
      return;
    }
    const noteId = selectedNote.id;
    // Drops in-flight responses once this effect is torn down (note switched,
    // status moved on, note deleted) so a late resolution can't apply a stale
    // snapshot — or surface a spurious "note not found" error after a delete.
    let cancelled = false;
    const interval = window.setInterval(() => {
      getNote(noteId)
        .then((note) => {
          if (cancelled) return;
          dispatch({ type: "noteUpdated", note });
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(messageFromError(err));
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedNote?.id, selectedNote?.processingStatus]);

  const handleCreateNote = useCallback(
    async (folderId?: string | null) => {
      try {
        const targetFolderId =
          folderId === null ? undefined : (folderId ?? state.selectedFolderId);
        const note = await createNote(targetFolderId);
        dispatch({ type: "noteLoaded", note });
        setOriginFolderId(undefined);
        setOriginAllNotes(false);
        setActiveView("meetings");
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [state.selectedFolderId],
  );

  // Mirrors the sidebar's "New session" button so the agent sessions list
  // can start a fresh chat with the same pending-session handshake. Memoized
  // so the ⌘N keydown listener below subscribes once instead of every render.
  const handleNewAgentSession = useCallback(() => {
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    markAgentNewSessionPending();
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT),
      );
    }, 0);
  }, []);

  useEffect(() => {
    if (
      appBlocked ||
      !bootstrapped ||
      activeView !== "meetings" ||
      selectedNote ||
      state.selectedNoteId
    ) {
      return;
    }
    void handleCreateNote(null);
  }, [
    activeView,
    appBlocked,
    bootstrapped,
    handleCreateNote,
    selectedNote,
    state.selectedNoteId,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return;
      if (isNewSessionShortcut(event)) {
        event.preventDefault();
        handleNewAgentSession();
        return;
      }
      if (isCreateNoteShortcut(event)) {
        event.preventDefault();
        void handleCreateNote(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCreateNote, handleNewAgentSession]);

  function handleSelectFolder(folderId?: string) {
    setFolderReturnTarget(undefined);
    dispatch({ type: "folderSelected", folderId });
  }

  async function handleReturnToNote(noteId: string) {
    if (state.selectedNoteId !== noteId) {
      await handleSelectNote(noteId);
    }
    setActiveView("meetings");
    setFolderReturnTarget(undefined);
  }

  async function handleCreateFolder(name: string, description?: string) {
    try {
      const folder = await createFolder(name, description);
      dispatch({ type: "folderCreated", folder });
      return folder;
    } catch (err) {
      setError(messageFromError(err));
      return undefined;
    }
  }

  async function handleRenameFolder(
    folderId: string,
    name: string,
    description?: string,
  ) {
    try {
      const folder = await renameFolder(folderId, name, description);
      dispatch({ type: "folderRenamed", folder });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleDeleteFolder(folderId: string) {
    try {
      // Deleting a project strips its association from any notes and agent
      // sessions but never deletes them — they stay in your library.
      await deleteFolder(folderId, false);
      dispatch({ type: "folderDeleted", folderId });
      setSessionFolders((prev) => {
        const next: Record<string, string[]> = {};
        for (const [sessionId, folderIds] of Object.entries(prev)) {
          const remaining = folderIds.filter((id) => id !== folderId);
          if (remaining.length > 0) next[sessionId] = remaining;
        }
        return next;
      });
    } catch (err) {
      setError(messageFromError(err));
      throw err;
    }
  }

  async function handleRemoveNoteFromFolder(noteId: string, folderId: string) {
    try {
      const note = await removeNoteFromFolder(noteId, folderId);
      dispatch({ type: "noteUpdated", note });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  // Single-folder semantics: a note belongs to at most one folder. Strip any
  // existing folder assignments before adding the target. Legacy notes with
  // multiple folders get normalized on the next move.
  async function handleSetNoteFolder(
    noteId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    const note = state.notes.find((n) => n.id === noteId);
    if (!note) return;
    if (note.folderIds.length === 1 && note.folderIds[0] === folderId) return;
    try {
      for (const existing of note.folderIds) {
        if (existing === folderId) continue;
        const updated = await removeNoteFromFolder(noteId, existing);
        dispatch({ type: "noteUpdated", note: updated });
      }
      if (!note.folderIds.includes(folderId)) {
        const updated = await assignNoteToFolder(noteId, folderId);
        dispatch({ type: "noteUpdated", note: updated });
      }
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
    }
  }

  // Single-project semantics for agent sessions, mirroring notes: a session
  // belongs to at most one project, so any existing assignment is stripped
  // before adding the target.
  async function handleSetSessionFolder(
    sessionId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    const current = sessionFolders[sessionId] ?? [];
    if (current.length === 1 && current[0] === folderId) return;
    try {
      for (const existing of current) {
        if (existing === folderId) continue;
        await removeSessionFromFolder(sessionId, existing);
      }
      if (!current.includes(folderId)) {
        await assignSessionToFolder(sessionId, folderId);
      }
      setSessionFolders((prev) => ({ ...prev, [sessionId]: [folderId] }));
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
    }
  }

  async function handleRemoveSessionFromFolder(
    sessionId: string,
    folderId: string,
  ) {
    try {
      await removeSessionFromFolder(sessionId, folderId);
      setSessionFolders((prev) => {
        const next = { ...prev };
        const remaining = (next[sessionId] ?? []).filter(
          (id) => id !== folderId,
        );
        if (remaining.length > 0) next[sessionId] = remaining;
        else delete next[sessionId];
        return next;
      });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  // "Report an issue": the fresh-chat handshake with a bug chip seeded into
  // the composer instead of auto-submitting, so the user types their report
  // after the tag. The submitted report (plus June's diagnosis) is filed to
  // the June team.
  function handleReportIssue(category: ReportCategory = "bug") {
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    markAgentNewSessionPending(undefined, { category });
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT, {
          detail: { category },
        }),
      );
    }, 0);
  }

  // "New session" from inside a project: same fresh-chat handshake, but the
  // session gets filed into the project once Hermes hands back its id.
  function handleNewAgentSessionInProject(folderId: string) {
    pendingSessionProjectRef.current = {
      folderId,
      knownSessionIds: new Set(agentSessions.map((session) => session.id)),
    };
    setAgentOrigin({ kind: "project", folderId });
    markAgentNewSessionPending();
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT),
      );
    }, 0);
  }

  // Leaves the agent workspace for the project it was entered from.
  function handleReturnToAgentOriginFolder() {
    if (agentOrigin?.kind !== "project") return;
    setActiveView("folders");
    dispatch({ type: "folderSelected", folderId: agentOrigin.folderId });
    setActiveAgentSession(undefined);
    setAgentOrigin(undefined);
  }

  // Back target for sessions opened outside a project: the Agents view-all.
  function handleReturnToAgentsList() {
    setActiveView("agent-sessions");
    setActiveAgentSession(undefined);
    setAgentOrigin(undefined);
  }

  // Leaves the agent workspace for the run history it was entered from.
  function handleReturnToRoutines() {
    setActiveView("routines");
    setActiveAgentSession(undefined);
    setAgentOrigin(undefined);
  }

  async function handleSelectNote(noteId: string) {
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(undefined);
      setOriginAllNotes(false);
      setFolderReturnTarget(undefined);
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  // Drilling into a note from the All notes view. Mirrors the folder flow so
  // the note opens with a "Back to All notes" breadcrumb up top.
  async function handleSelectNoteFromAllNotes(noteId: string) {
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(undefined);
      setOriginAllNotes(true);
      setFolderReturnTarget(undefined);
      setActiveView("meetings");
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleDeleteNote(noteId: string) {
    if (state.recordingStatus) {
      setError("Stop the current recording before deleting a note.");
      return;
    }
    try {
      await deleteNote(noteId);
      pruneDeletedNoteTabs(new Set([noteId]));
      const response = await listNotes();
      dispatch({ type: "notesLoaded", notes: response.items });
      const nextNoteId = response.items[0]?.id;
      if (nextNoteId) {
        const note = await getNote(nextNoteId);
        dispatch({ type: "noteLoaded", note });
      } else {
        setActiveView("settings");
        setOriginFolderId(undefined);
        setFolderReturnTarget(undefined);
      }
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleDeleteNotes(noteIds: string[]) {
    if (state.recordingStatus) {
      setError("Stop the current recording before deleting meetings.");
      return;
    }
    try {
      await deleteNotes(noteIds);
      pruneDeletedNoteTabs(new Set(noteIds));
      const response = await listNotes();
      dispatch({ type: "notesLoaded", notes: response.items });
      const nextNoteId = response.items[0]?.id;
      if (nextNoteId) {
        const note = await getNote(nextNoteId);
        dispatch({ type: "noteLoaded", note });
      } else {
        setActiveView("settings");
        setOriginFolderId(undefined);
        setFolderReturnTarget(undefined);
      }
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleSelectNoteFromFolder(noteId: string, folderId: string) {
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(folderId);
      setOriginAllNotes(false);
      setFolderReturnTarget(undefined);
      setActiveView("meetings");
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleUpdateNote(
    patch: Partial<Pick<NoteDto, "title" | "editedContent">>,
  ) {
    if (!selectedNote) return;
    const optimistic = {
      ...selectedNote,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    dispatch({ type: "noteUpdated", note: optimistic });
    try {
      const note = await updateNote({
        noteId: selectedNote.id,
        title: patch.title,
        editedContent: patch.editedContent,
      });
      dispatch({ type: "noteUpdated", note });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  const handleStartRecordingForNote = useCallback(
    async (
      noteId: string,
      options: { startAlreadyClaimed?: boolean } = {},
    ): Promise<boolean> => {
      const startAlreadyClaimed = options.startAlreadyClaimed ?? false;
      if (
        recordingStatusRef.current ||
        (!startAlreadyClaimed && recordingStartInFlightRef.current)
      ) {
        if (startAlreadyClaimed) {
          recordingStartInFlightRef.current = false;
        }
        return false;
      }
      if (!startAlreadyClaimed) {
        recordingStartInFlightRef.current = true;
      }
      setLiveTranscriptEvents([]);
      setRecordingNote(noteId);
      const startingStatus = startingRecordingStatus(noteId, sourceMode);
      recordingStatusRef.current = startingStatus;
      dispatch({
        type: "recordingStatusChanged",
        status: startingStatus,
      });
      try {
        setCheckingSourceReadiness(true);
        const readiness = await checkRecordingSourceReadiness(sourceMode);
        setSourceReadiness(readiness);

        const micSource = readiness.sources.find(
          (source) => source.source === "microphone",
        );
        if (!micSource?.ready) {
          setRecordingNote(undefined);
          recordingStatusRef.current = undefined;
          dispatch({ type: "recordingStatusCleared" });
          setError(micSource?.message ?? "Microphone is not ready.");
          return false;
        }

        // System audio is optional. If the fresh probe shows it isn't
        // available, fall back to mic-only for this take — the derived
        // sourceMode will follow automatically next render via
        // setSourceReadiness above.
        const systemSource = readiness.sources.find(
          (source) => source.source === "system",
        );
        const effectiveMode: RecordingSourceMode =
          sourceMode === "microphonePlusSystem" && !systemSource?.ready
            ? "microphoneOnly"
            : sourceMode;

        const recording = await startRecording(noteId, effectiveMode);
        setRecordingNote(noteId);
        const status = recordingToStatus(recording);
        recordingStatusRef.current = status;
        dispatch({
          type: "recordingStatusChanged",
          status,
        });
        playRecordingSound("start");
        return true;
      } catch (err) {
        // The ref was set optimistically above; a failed start must not leave
        // the meeting HUD's reopen path pointing at a note with no recording.
        setRecordingNote(undefined);
        recordingStatusRef.current = undefined;
        dispatch({ type: "recordingStatusCleared" });
        setError(messageFromError(err));
        return false;
      } finally {
        recordingStartInFlightRef.current = false;
        setCheckingSourceReadiness(false);
      }
    },
    [setRecordingNote, sourceMode],
  );

  const handleStartRecording = useCallback(async () => {
    if (!selectedNoteId) return;
    await handleStartRecordingForNote(selectedNoteId);
  }, [handleStartRecordingForNote, selectedNoteId]);

  const handleStartMeetingDetectedRecording = useCallback(async () => {
    if (recordingStartInFlightRef.current || recordingStatusRef.current) return;
    recordingStartInFlightRef.current = true;
    const previousNoteId = selectedNoteId;
    let handedStartClaimToRecorder = false;
    try {
      const note = await createNote(undefined);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(undefined);
      setOriginAllNotes(false);
      setActiveView("meetings");
      handedStartClaimToRecorder = true;
      const started = await handleStartRecordingForNote(note.id, {
        startAlreadyClaimed: true,
      });
      if (started) return;

      await deleteNote(note.id);
      const response = await listNotes();
      dispatch({ type: "notesLoaded", notes: response.items });
      const restoreNoteId =
        previousNoteId && previousNoteId !== note.id
          ? previousNoteId
          : response.items[0]?.id;
      if (restoreNoteId) {
        const restored = await getNote(restoreNoteId);
        dispatch({ type: "noteLoaded", note: restored });
      } else {
        setActiveView("settings");
      }
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      if (!handedStartClaimToRecorder) {
        recordingStartInFlightRef.current = false;
      }
    }
  }, [handleStartRecordingForNote, selectedNoteId]);

  // Click the floating global recorder pill to jump back to the note the
  // recording belongs to (it lives wherever you started it, which may not be
  // the note you're currently looking at).
  const handleOpenRecordingNote = useCallback(async () => {
    const noteId = recordingNoteIdRef.current;
    if (!noteId) return;
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(undefined);
      setOriginAllNotes(false);
      setFolderReturnTarget(undefined);
      setActiveView("meetings");
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen(MEETING_START_TRANSCRIPTION_EVENT, () => {
      if (appBlocked || !bootstrapped) return;
      void handleStartMeetingDetectedRecording();
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [appBlocked, bootstrapped, handleStartMeetingDetectedRecording]);

  async function handleFinishRecording(sessionId: string) {
    // The recorder bar stays mounted (and clickable) for the duration of its
    // exit animation after the first stop click, so a fast double-click would
    // fire finishRecording twice — the second call fails with a scary
    // "recording not found" error. Gate per session until the call settles.
    if (finishingSessionsRef.current.has(sessionId)) return;
    finishingSessionsRef.current.add(sessionId);
    // Collapse the shell back to idle the instant stop is pressed so it
    // never lingers wide while the (potentially long) transcribe +
    // generate pipeline runs. Processing is queued per note, so the record
    // button stays available — you can stack another take while this one
    // finishes — and the body shimmer ("Transcribing audio…" → "Generating
    // notes…") plus a queued count tell the user work is still in flight.
    const owningNoteId = recordingNoteIdRef.current;
    dispatch({ type: "recordingStatusCleared" });
    setLiveTranscriptEvents([]);
    setRecordingNote(undefined);
    playRecordingSound("stop");
    // Optimistically flip the note that owns this recording to transcribing.
    // The selected note isn't necessarily that note — the user may have
    // browsed elsewhere while recording — and stamping the wrong note as
    // transcribing would lock its record button and shimmer forever.
    if (selectedNote && selectedNote.id === owningNoteId) {
      dispatch({
        type: "noteProcessingUpdated",
        note: { ...selectedNote, processingStatus: "transcribing" },
      });
    }
    try {
      const result = await finishRecording(sessionId);
      dispatch({ type: "noteProcessingUpdated", note: result.note });
    } catch (err) {
      if (
        !owningNoteId ||
        !(await applyNoteScopedProcessingFailure(owningNoteId, err))
      ) {
        setError(messageFromError(err));
      }
    } finally {
      finishingSessionsRef.current.delete(sessionId);
    }
  }

  async function applyNoteScopedProcessingFailure(
    noteId: string,
    err: unknown,
  ) {
    try {
      const note = await getNote(noteId);
      if (note.processingStatus !== "failed") return false;
      dispatch({ type: "noteProcessingUpdated", note });
      setError(null);
      return true;
    } catch {
      return false;
    }
  }

  const handlePauseRecording = useCallback(async (sessionId: string) => {
    try {
      const status = await pauseRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
      playRecordingSound("pause");
      return true;
    } catch (err) {
      setError(messageFromError(err));
      return false;
    }
  }, []);

  async function handleResumeRecording(sessionId: string) {
    playRecordingSound("start");
    try {
      const status = await resumeRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  useEffect(() => {
    const status = state.recordingStatus;
    const now = Date.now();
    const decision = nextRecordingInactivityDecision(
      recordingInactivityTrackerRef.current,
      status,
      now,
    );
    recordingInactivityTrackerRef.current = decision.tracker;

    if (
      recordingInactivityPrompt &&
      (!status ||
        status.sessionId !== recordingInactivityPrompt.sessionId ||
        status.state !== "recording" ||
        recordingHasActivity(status))
    ) {
      setRecordingInactivityPrompt(null);
      return;
    }

    if (
      !status ||
      !decision.shouldPrompt ||
      recordingInactivityPrompt?.sessionId === status.sessionId
    ) {
      return;
    }

    const prompt = {
      sessionId: status.sessionId,
      expiresAt: now + RECORDING_INACTIVITY_RESPONSE_MS,
    };
    setRecordingInactivityNow(now);
    setRecordingInactivityPrompt(prompt);
    void notifyRecordingStillMeetingPrompt(status.sessionId);
  }, [recordingInactivityPrompt, state.recordingStatus]);

  useEffect(() => {
    if (!recordingInactivityPrompt) return;

    setRecordingInactivityNow(Date.now());
    const tick = window.setInterval(() => {
      setRecordingInactivityNow(Date.now());
    }, 1000);
    const timeout = window.setTimeout(() => {
      const currentStatus = recordingStatusRef.current;
      const sessionId = recordingInactivityPrompt.sessionId;
      recordingInactivityTrackerRef.current = { sessionId };
      setRecordingInactivityPrompt(null);
      if (
        currentStatus?.sessionId !== sessionId ||
        currentStatus.state !== "recording"
      ) {
        return;
      }
      void handlePauseRecording(sessionId).then((paused) => {
        if (paused) void notifyRecordingAutoPaused(sessionId);
      });
    }, Math.max(0, recordingInactivityPrompt.expiresAt - Date.now()));

    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timeout);
    };
  }, [handlePauseRecording, recordingInactivityPrompt]);

  function handleKeepRecordingAfterInactivityPrompt() {
    const sessionId = recordingInactivityPrompt?.sessionId;
    if (sessionId) {
      recordingInactivityTrackerRef.current = {
        sessionId,
        snoozedUntil: Date.now() + RECORDING_INACTIVITY_SNOOZE_MS,
      };
    }
    setRecordingInactivityPrompt(null);
  }

  function handlePauseRecordingAfterInactivityPrompt() {
    const sessionId = recordingInactivityPrompt?.sessionId;
    if (!sessionId) return;
    recordingInactivityTrackerRef.current = { sessionId };
    setRecordingInactivityPrompt(null);
    void handlePauseRecording(sessionId);
  }

  const recordingInactivitySecondsRemaining = recordingInactivityPrompt
    ? Math.max(
        0,
        Math.ceil(
          (recordingInactivityPrompt.expiresAt - recordingInactivityNow) / 1000,
        ),
      )
    : 0;

  if (accountLoading) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <div
          className="welcome-screen welcome-screen-loading"
          aria-label="Loading account"
        />
      </main>
    );
  }

  if (onboardingRequired) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <OnboardingFlow
          account={account}
          onAccountChanged={handleAccountChanged}
          onRefreshAccount={refreshAccount}
          onComplete={() => {
            markOnboardingComplete();
            setOnboardingDone(true);
          }}
        />
      </main>
    );
  }

  if (signInRequired) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <AccountGate
          account={account}
          loading={accountLoading}
          onAccountChanged={handleAccountChanged}
        />
      </main>
    );
  }

  if (trialRequired) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <TrialGate
          account={account}
          onRefresh={refreshAccount}
          onSignOut={() => void handleSignOut()}
        />
      </main>
    );
  }

  // The in-note RecorderBar covers the recording while you're looking at its
  // note. Elsewhere, the sidebar header carries a tiny recording presence; the
  // floating pill is only the collapsed-sidebar fallback.
  const viewingRecordingNote =
    activeView === "meetings" &&
    selectedNoteId !== undefined &&
    selectedNoteId === recordingNoteId;
  const recorderPresenceVisible =
    Boolean(state.recordingStatus) && !viewingRecordingNote;
  const recordingNoteTitle =
    (selectedNote?.id === recordingNoteId
      ? selectedNote?.title
      : state.notes.find((note) => note.id === recordingNoteId)?.title
    )?.trim() || "New note";
  // The dev console demo (window.__globalRecorderPill) force-shows the recorder
  // presence with synthetic status; otherwise it tracks the real recording.
  const recorderPresenceStatus =
    demoRecorderStatus ??
    (recorderPresenceVisible ? state.recordingStatus : null);
  const sidebarRecorderStatus =
    recorderPresenceStatus && !sidebarCollapsed && activeView !== "settings"
      ? recorderPresenceStatus
      : null;
  const pillStatus =
    recorderPresenceStatus && !sidebarRecorderStatus
      ? recorderPresenceStatus
      : null;
  const pillIsDemo = demoRecorderStatus !== null;

  return (
    <main
      className="app-shell"
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
      data-sidebar-resizing={sidebarResizing ? "true" : "false"}
      data-sidebar-transition={sidebarTransition}
      style={
        {
          // The grid columns read this directly, so collapsed must pin it to 0
          // (the stored width is preserved for the next expand). During a drag
          // the resize logic overrides it imperatively.
          "--sidebar-w-current": `${sidebarCollapsed ? 0 : sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <div
        className="titlebar-drag"
        aria-hidden
        data-tauri-drag-region
        onPointerDown={handleTitlebarPointerDown}
      />
      <button
        type="button"
        className="chrome-sidebar-toggle"
        aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        aria-pressed={sidebarCollapsed}
        onClick={() => {
          setSidebarTransition("none");
          if (sidebarCollapsed) {
            setSidebarWidth((width) => Math.max(width, SIDEBAR_DEFAULT_WIDTH));
            setSidebarCollapsed(false);
            return;
          }
          setSidebarCollapsed(true);
        }}
      >
        <SidebarToggleGlyph />
      </button>
      <Sidebar
        notes={state.notes}
        activeView={activeView}
        account={account}
        settingsTab={settingsTab}
        onSettingsTabChange={setSettingsTab}
        onChangeView={(view) => {
          if (takeNewTabIntent()) {
            openTab({ view });
            return;
          }
          if (view === "settings") openSettings();
          else setActiveView(view);
          setAgentOrigin(undefined);
          if (view !== "agent") {
            setActiveAgentSession(undefined);
            pendingSessionProjectRef.current = null;
          }
          if (view === "folders") {
            setFolderReturnTarget(undefined);
            dispatch({ type: "folderSelected", folderId: undefined });
          }
          if (view !== "meetings" && view !== "notes") {
            setOriginFolderId(undefined);
            setOriginAllNotes(false);
            setFolderReturnTarget(undefined);
          }
        }}
        onExitSettings={() => setActiveView(settingsReturnView)}
        onSignOut={() => void handleSignOut()}
        onReportIssue={handleReportIssue}
        onSelectNote={(noteId) => {
          if (takeNewTabIntent()) {
            openTab({ view: "meetings", noteId });
            return;
          }
          void handleSelectNote(noteId);
        }}
        onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
        onOpenMoveDialog={(noteId) => setMoveDialogNoteIds([noteId])}
        onRemoveNoteFromFolder={(noteId, folderId) =>
          void handleRemoveNoteFromFolder(noteId, folderId)
        }
        onNewAgentSession={() => {
          pendingSessionProjectRef.current = null;
          setAgentOrigin(undefined);
          setActiveAgentSession(undefined);
          setActiveView("agent");
        }}
        onSelectAgentSession={(session) => {
          if (takeNewTabIntent()) {
            openTab({ view: "agent", agentSessionId: session.id });
            return;
          }
          setAgentOrigin(undefined);
          setActiveAgentSession(session);
          setActiveView("agent");
        }}
        recoverableNoteIds={recoverableNoteIds}
        recordingStatus={sidebarRecorderStatus}
        recordingTitle={recordingNoteTitle}
        onOpenRecording={() =>
          pillIsDemo ? undefined : void handleOpenRecordingNote()
        }
        collapsed={sidebarCollapsed}
        footerAccessory={
          <UpdateHub
            readyUpdate={readyUpdate}
            status={updateStatus}
            preparing={preparingUpdate}
            relaunching={relaunchingUpdate}
            progress={updateProgress}
            onDismissStatus={() => {
              if (preparingUpdate) updateProgressHiddenRef.current = true;
              setUpdateStatus(null);
              if (!preparingUpdate) setUpdateProgress(null);
            }}
            onRelaunch={handleRelaunchUpdate}
          />
        }
      />
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(event) =>
          handleSidebarResizeStart(event, sidebarWidth, {
            collapseWidth: SIDEBAR_COLLAPSE_WIDTH,
            minWidth: SIDEBAR_MIN_WIDTH,
            maxWidth: sidebarMaxWidth,
            onStart: () => {
              setSidebarResizing(true);
              setSidebarTransition("none");
            },
            onEnd: (finalWidth) => {
              if (finalWidth <= SIDEBAR_COLLAPSE_WIDTH) {
                setSidebarResizing(false);
                setSidebarTransition("smooth");
                setSidebarWidth(Math.max(0, finalWidth));
                setSidebarCollapsed(true);
                return;
              }
              const nextWidth = Math.min(
                sidebarMaxWidth(),
                Math.max(SIDEBAR_MIN_WIDTH, finalWidth),
              );
              setSidebarResizing(false);
              setSidebarCollapsed(false);
              setSidebarWidth(nextWidth);
            },
          })
        }
      />
      <div className="main-column">
        <TabBar
          tabs={tabItems}
          activeTabId={activeTabId}
          onActivate={activateTab}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onNew={openNewChatTab}
          layoutFrozen={sidebarResizing}
          onDragRegionPointerDown={handleTitlebarPointerDown}
        />
        <section className="main-panel">
          {accessibilityBlocked ? (
            <PermissionBanner
              onEnableAccessibility={handleEnableAccessibility}
            />
          ) : null}
          <div
            ref={mainPanelBodyRef}
            className="main-panel-body"
            data-active-view={activeView}
            data-detail-scroller={detailScrollerActive ? "true" : undefined}
            data-note-detail-scroller={
              noteDetailScrollerActive ? "true" : undefined
            }
          >
            {error ? <p className="error-banner">{error}</p> : null}
            <div className="workspace">
              {activeView === "settings" ? (
                <AppSettings
                  account={account}
                  accountLoading={accountLoading}
                  sourceMode={sourceMode}
                  sourceReadiness={sourceReadiness}
                  checkingSourceReadiness={checkingSourceReadiness}
                  microphonePermissionStatus={microphoneStatus}
                  accessibilityPermissionStatus={accessibilityStatus}
                  onAccountChanged={handleAccountChanged}
                  onAccountRefresh={refreshAccount}
                  onSourceModeChange={handleSourceModeChange}
                  onEnableMicrophone={handleEnableMicrophone}
                  onEnableAccessibility={handleEnableAccessibility}
                  onEnableSystemAudio={handleEnableSystemAudio}
                  activeTab={settingsTab}
                  onTabChange={setSettingsTab}
                  onCheckForUpdates={() => runUpdateCheck("manual")}
                  onReportIssue={handleReportIssue}
                />
              ) : activeView === "dictation" ? (
                <DictationHistoryView
                  onNavigateToSettings={(target) => {
                    setSettingsReturnView(activeView);
                    setActiveView("settings");
                    setSettingsTab("dictation");
                    const headingId =
                      target === "style"
                        ? "style-heading"
                        : "dictionary-heading";
                    window.setTimeout(() => {
                      document.getElementById(headingId)?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                    }, 80);
                  }}
                />
              ) : activeView === "routines" ? (
                <RoutinesView
                  onCreateRoutine={(prompt) => {
                    // The agent workspace is unmounted while Routines is shown,
                    // so the pending marker alone is consumed on mount — no
                    // window event needed (it could double-submit the session).
                    markAgentNewSessionPending(prompt);
                    setActiveAgentSession(undefined);
                    setActiveView("agent");
                  }}
                  onOpenRun={(session) => {
                    if (takeNewTabIntent()) {
                      openTab({
                        view: "agent",
                        agentSessionId: session.id,
                        agentOrigin: { kind: "routines" },
                      });
                      return;
                    }
                    setAgentOrigin({ kind: "routines" });
                    setActiveAgentSession(session);
                    setActiveView("agent");
                  }}
                />
              ) : activeView === "agent" ? (
                // The origin crumbs render inside the workspace's own sticky
                // session bar, so they persist while the chat scrolls beneath.
                <AgentWorkspace
                  initialSession={activeAgentSession}
                  origin={
                    agentOriginFolder
                      ? {
                          backLabel: `Back to ${agentOriginFolder.name}`,
                          onBack: handleReturnToAgentOriginFolder,
                          crumbs: [
                            {
                              label: "Projects",
                              onClick: () => {
                                setActiveView("folders");
                                dispatch({
                                  type: "folderSelected",
                                  folderId: undefined,
                                });
                                setActiveAgentSession(undefined);
                                setAgentOrigin(undefined);
                              },
                            },
                            {
                              label: agentOriginFolder.name,
                              onClick: handleReturnToAgentOriginFolder,
                            },
                          ],
                        }
                      : agentOrigin?.kind === "routines"
                        ? {
                            backLabel: "Back to routines",
                            onBack: handleReturnToRoutines,
                            crumbs: [
                              {
                                label: "Routines",
                                onClick: handleReturnToRoutines,
                              },
                            ],
                          }
                        : {
                            backLabel: "Back to sessions",
                            onBack: handleReturnToAgentsList,
                            crumbs: [
                              {
                                label: "Sessions",
                                onClick: handleReturnToAgentsList,
                              },
                            ],
                          }
                  }
                />
              ) : activeView === "agent-sessions" ? (
                <AgentSessionsList
                  ref={agentSessionsListRef}
                  sessions={agentSessions}
                  folders={state.folders}
                  sessionFolderIds={sessionFolders}
                  workingSessionIds={agentWorkingSessionIds}
                  waitingSessionIds={agentWaitingSessionIds}
                  onSelectSession={(session) => {
                    if (takeNewTabIntent()) {
                      openTab({ view: "agent", agentSessionId: session.id });
                      return;
                    }
                    setAgentOrigin(undefined);
                    setActiveAgentSession(session);
                    setActiveView("agent");
                  }}
                  onNewSession={handleNewAgentSession}
                  onOpenMoveDialog={(sessionId) =>
                    setMoveDialogSessionIds([sessionId])
                  }
                  onOpenMoveSessions={(sessionIds) =>
                    setMoveDialogSessionIds(sessionIds)
                  }
                  onRemoveFromProject={(sessionId, folderId) =>
                    void handleRemoveSessionFromFolder(sessionId, folderId)
                  }
                />
              ) : activeView === "notes" || activeView === "all-notes" ? (
                <NotesList
                  ref={notesListRef}
                  notes={state.notes}
                  activeRecordingNoteId={recordingNoteId}
                  onSelectNote={(noteId) => {
                    if (takeNewTabIntent()) {
                      openTab({
                        view: "meetings",
                        noteId,
                        originAllNotes: true,
                      });
                      return;
                    }
                    void handleSelectNoteFromAllNotes(noteId);
                  }}
                  onCreateNote={() => void handleCreateNote(null)}
                  onOpenMoveDialog={(noteId) => setMoveDialogNoteIds([noteId])}
                  onOpenMoveNotes={(noteIds) => setMoveDialogNoteIds(noteIds)}
                  onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
                  onDeleteNotes={(noteIds) => void handleDeleteNotes(noteIds)}
                />
              ) : activeView === "folders" ? (
                <FoldersWorkspace
                  folders={state.folders}
                  notes={state.notes}
                  sessions={agentSessions}
                  sessionFolderIds={sessionFolders}
                  selectedFolderId={state.selectedFolderId}
                  folderBackTarget={
                    folderReturnTarget
                      ? {
                          label: `Back to ${folderReturnTarget.label}`,
                          onBack: () =>
                            void handleReturnToNote(folderReturnTarget.noteId),
                        }
                      : undefined
                  }
                  onSelectFolder={(folderId) => handleSelectFolder(folderId)}
                  onCreateFolder={(name, description) =>
                    handleCreateFolder(name, description)
                  }
                  onRenameFolder={(folderId, name, description) =>
                    void handleRenameFolder(folderId, name, description)
                  }
                  onDeleteFolder={(folderId) => handleDeleteFolder(folderId)}
                  onCreateNote={(folderId) => void handleCreateNote(folderId)}
                  onSelectNote={(noteId) => {
                    const folderId = state.selectedFolderId;
                    if (takeNewTabIntent()) {
                      openTab({
                        view: "meetings",
                        noteId,
                        originFolderId: folderId,
                      });
                      return;
                    }
                    if (folderId) {
                      void handleSelectNoteFromFolder(noteId, folderId);
                    } else {
                      void handleSelectNote(noteId).then(() =>
                        setActiveView("meetings"),
                      );
                    }
                  }}
                  onAssignNoteToFolder={(noteId, folderId) =>
                    handleSetNoteFolder(noteId, folderId, { rethrow: true })
                  }
                  onRemoveNoteFromFolder={(noteId, folderId) =>
                    void handleRemoveNoteFromFolder(noteId, folderId)
                  }
                  onOpenMoveDialog={(noteId) => setMoveDialogNoteIds([noteId])}
                  onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
                  onCreateSession={(folderId) =>
                    handleNewAgentSessionInProject(folderId)
                  }
                  onSelectSession={(session) => {
                    // Remember the project so the agent view can breadcrumb
                    // back to it.
                    const agentOriginValue = state.selectedFolderId
                      ? ({
                          kind: "project",
                          folderId: state.selectedFolderId,
                        } as const)
                      : undefined;
                    if (takeNewTabIntent()) {
                      openTab({
                        view: "agent",
                        agentSessionId: session.id,
                        agentOrigin: agentOriginValue,
                      });
                      return;
                    }
                    setAgentOrigin(agentOriginValue);
                    setActiveAgentSession(session);
                    setActiveView("agent");
                  }}
                  onAssignSessionToFolder={(sessionId, folderId) =>
                    handleSetSessionFolder(sessionId, folderId, {
                      rethrow: true,
                    })
                  }
                  onRemoveSessionFromFolder={(sessionId, folderId) =>
                    void handleRemoveSessionFromFolder(sessionId, folderId)
                  }
                  onOpenSessionMoveDialog={(sessionId) =>
                    setMoveDialogSessionIds([sessionId])
                  }
                />
              ) : selectedNote ? (
                <div className="note-shell">
                  {originFolder ? (
                    <BreadcrumbBar
                      backLabel={`Back to ${originFolder.name}`}
                      onBack={() => {
                        setActiveView("folders");
                        dispatch({
                          type: "folderSelected",
                          folderId: originFolder.id,
                        });
                        setOriginFolderId(undefined);
                      }}
                      items={[
                        {
                          label: originFolder.name,
                          onClick: () => {
                            setActiveView("folders");
                            dispatch({
                              type: "folderSelected",
                              folderId: originFolder.id,
                            });
                            setOriginFolderId(undefined);
                          },
                        },
                        {
                          label: selectedNote.title.trim() || "New note",
                        },
                      ]}
                    />
                  ) : originAllNotes ? (
                    <BreadcrumbBar
                      backLabel="Back to meeting notes"
                      onBack={() => {
                        setActiveView("all-notes");
                        setOriginAllNotes(false);
                      }}
                      items={[
                        {
                          label: "Meeting notes",
                          onClick: () => {
                            setActiveView("all-notes");
                            setOriginAllNotes(false);
                          },
                        },
                        {
                          label: selectedNote.title.trim() || "New note",
                        },
                      ]}
                    />
                  ) : null}
                  <div
                    ref={noteDetailScrollRef}
                    className="note-detail-scroll"
                    data-has-detail-bar={noteHasBreadcrumb ? "true" : undefined}
                  >
                    <NoteEditor
                      note={selectedNote}
                      folders={state.folders}
                      recordingStatus={
                        selectedNoteId === recordingNoteId
                          ? state.recordingStatus
                          : undefined
                      }
                      recordingDisabled={Boolean(
                        state.recordingStatus &&
                        selectedNoteId !== recordingNoteId,
                      )}
                      liveTranscript={
                        selectedNoteId === recordingNoteId
                          ? liveTranscriptEvents
                          : []
                      }
                      sourceMode={sourceMode}
                      sourceReadiness={sourceReadiness}
                      recovery={selectedRecovery}
                      onRecoverRecording={(sessionId) =>
                        handleRecovery(sessionId, "validate")
                      }
                      onDiscardRecording={(sessionId) =>
                        handleRecovery(sessionId, "discard")
                      }
                      onTitleChange={(title) =>
                        void handleUpdateNote({ title })
                      }
                      onContentChange={(sourceNoteId, editedContent) => {
                        // Blur fired by an editor that was already torn
                        // down on note-switch — ignore so we don't write
                        // the old note's content into the new selectedNote.
                        if (sourceNoteId !== selectedNote.id) return;
                        void handleUpdateNote({ editedContent });
                      }}
                      onSourceModeChange={handleSourceModeChange}
                      onEnableSystemAudio={handleEnableSystemAudio}
                      onEnableMicrophone={handleEnableMicrophone}
                      microphoneBlocked={microphoneBlocked}
                      onTabChange={(activeTab) =>
                        void updateNote({
                          noteId: selectedNote.id,
                          activeTab,
                        }).then((note) =>
                          dispatch({ type: "noteUpdated", note }),
                        )
                      }
                      onStartRecording={() => void handleStartRecording()}
                      onPauseRecording={(sessionId) =>
                        void handlePauseRecording(sessionId)
                      }
                      onResumeRecording={(sessionId) =>
                        void handleResumeRecording(sessionId)
                      }
                      onFinishRecording={(sessionId) =>
                        void handleFinishRecording(sessionId)
                      }
                      onRetry={async () => {
                        if (!selectedNote) return;
                        try {
                          const note = await retryProcessing(selectedNote.id);
                          dispatch({ type: "noteProcessingUpdated", note });
                        } catch (err) {
                          const message = messageFromError(err);
                          dispatch({
                            type: "noteProcessingUpdated",
                            note: {
                              ...selectedNote,
                              processingStatus: "failed",
                              lastError: message,
                            },
                          });
                          setError(null);
                          throw err;
                        }
                      }}
                      onTopUp={() =>
                        void osAccountsTopUp().catch((err: unknown) =>
                          setError(messageFromError(err)),
                        )
                      }
                      onAssignFolder={(folderId) =>
                        void handleSetNoteFolder(selectedNote.id, folderId)
                      }
                      onRemoveFolder={(folderId) =>
                        void handleRemoveNoteFromFolder(
                          selectedNote.id,
                          folderId,
                        )
                      }
                      onNavigateToFolder={(folderId) => {
                        setActiveView("folders");
                        dispatch({ type: "folderSelected", folderId });
                        setFolderReturnTarget({
                          noteId: selectedNote.id,
                          label: selectedNote.title.trim() || "New note",
                        });
                        setOriginFolderId(undefined);
                      }}
                      onCreateAndAssignFolder={(name) => {
                        void (async () => {
                          const folder = await handleCreateFolder(name);
                          if (folder) {
                            await handleSetNoteFolder(
                              selectedNote.id,
                              folder.id,
                            );
                          }
                        })();
                      }}
                    />
                  </div>
                </div>
              ) : (
                <section className="editor-empty" aria-label="Opening note" />
              )}
            </div>
          </div>
          <AnimatePresence>
            {pillStatus ? (
              <motion.div
                key="global-recorder"
                className="global-recorder-dock"
                initial={{ opacity: 0, y: -8 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
                }}
                exit={{
                  opacity: 0,
                  y: -8,
                  transition: { duration: 0.14, ease: [0.22, 1, 0.36, 1] },
                }}
              >
                <GlobalRecorderPill
                  status={pillStatus}
                  title={recordingNoteTitle}
                  onOpen={() =>
                    pillIsDemo ? undefined : void handleOpenRecordingNote()
                  }
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
      </div>
      <Dialog
        open={recordingInactivityPrompt !== null}
        onClose={handleKeepRecordingAfterInactivityPrompt}
        title="Still in a meeting?"
        description="June has not heard meeting audio for a while."
        width={420}
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={handlePauseRecordingAfterInactivityPrompt}
            >
              Pause recording
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={handleKeepRecordingAfterInactivityPrompt}
            >
              Keep recording
            </button>
          </>
        }
      >
        <div className="dialog-body">
          <p className="recording-inactivity-copy">
            June will pause this recording in{" "}
            {recordingInactivitySecondsRemaining} seconds if you do not answer.
          </p>
        </div>
      </Dialog>
      <MoveNoteToFolderDialog
        open={moveDialogNoteIds !== null}
        onClose={() => setMoveDialogNoteIds(null)}
        notes={
          moveDialogNoteIds
            ? moveDialogNoteIds
                .map((id) => state.notes.find((n) => n.id === id))
                .filter((note): note is NoteListItemDto => note !== undefined)
            : []
        }
        folders={state.folders}
        onSetFolder={(noteId, folderId) =>
          handleSetNoteFolder(noteId, folderId)
        }
        onMoved={() => notesListRef.current?.resetSelection()}
      />
      <MoveSessionToProjectDialog
        open={moveDialogSessionIds !== null}
        onClose={() => setMoveDialogSessionIds(null)}
        sessions={
          moveDialogSessionIds
            ? moveDialogSessionIds
                .map((id) => agentSessions.find((s) => s.id === id))
                .filter(
                  (session): session is HermesSessionInfo =>
                    session !== undefined,
                )
            : []
        }
        sessionFolderIds={sessionFolders}
        folders={state.folders}
        onSetFolder={(sessionId, folderId) =>
          handleSetSessionFolder(sessionId, folderId)
        }
        onMoved={() => agentSessionsListRef.current?.resetSelection()}
      />
    </main>
  );
}

function updateMenuBarSessionStatus(
  sessionId: string,
  status: AgentSessionStatusDetail["status"],
  sessions: { working: Set<string>; waiting: Set<string> },
) {
  if (status === "waitingForUser") {
    sessions.working.delete(sessionId);
    sessions.waiting.add(sessionId);
    return;
  }
  if (status === "starting" || status === "running") {
    sessions.waiting.delete(sessionId);
    sessions.working.add(sessionId);
    return;
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    sessions.working.delete(sessionId);
    sessions.waiting.delete(sessionId);
  }
}

function UpdateHub({
  readyUpdate,
  status,
  preparing,
  relaunching,
  progress,
  onDismissStatus,
  onRelaunch,
}: {
  readyUpdate: UpdatePromptPayload<ScribeUpdate> | null;
  status: string | null;
  preparing: boolean;
  relaunching: boolean;
  progress: UpdateInstallProgress | null;
  onDismissStatus: () => void;
  onRelaunch: () => void;
}) {
  if (readyUpdate) {
    return (
      <UpdateRelaunchCard
        payload={readyUpdate}
        status={status}
        relaunching={relaunching}
        onRelaunch={onRelaunch}
      />
    );
  }

  if (!status) return null;
  return (
    <UpdateStatusCard
      status={status}
      preparing={preparing}
      progress={progress}
      onDismiss={onDismissStatus}
    />
  );
}

function UpdateRelaunchCard({
  payload,
  status,
  relaunching,
  onRelaunch,
}: {
  payload: UpdatePromptPayload<ScribeUpdate>;
  status: string | null;
  relaunching: boolean;
  onRelaunch: () => void;
}) {
  const meta = status ?? updateVersionLabel(payload.version);
  const failed = status?.toLowerCase().includes("failed") ?? false;

  return (
    <aside
      className="update-popover"
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      <button
        type="button"
        className="update-relaunch-card"
        disabled={relaunching}
        aria-label={`Relaunch to update to June ${payload.version}`}
        onClick={onRelaunch}
      >
        <span className="update-relaunch-mark" aria-hidden>
          <JuneMark />
        </span>
        <span className="update-relaunch-copy">
          <span className="update-relaunch-title">
            {relaunching ? "Relaunching..." : "Relaunch to update"}
          </span>
          <span className={status ? "update-relaunch-status" : undefined}>
            {meta}
          </span>
        </span>
        <IconArrowRight
          className="update-relaunch-arrow"
          size={18}
          aria-hidden
        />
      </button>
    </aside>
  );
}

function UpdateStatusCard({
  status,
  preparing,
  progress,
  onDismiss,
}: {
  status: string;
  preparing: boolean;
  progress: UpdateInstallProgress | null;
  onDismiss: () => void;
}) {
  const percent = updateProgressPercent(progress);
  const progressWidth =
    progress?.state === "installing" && percent === undefined
      ? "100%"
      : `${percent ?? 0}%`;
  const failed = status.toLowerCase().includes("failed");

  return (
    <aside
      className="update-popover update-status-card"
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="update-status-row">
        <span className="update-status-icon" aria-hidden>
          <IconArrowInbox size={15} />
        </span>
        <span className="update-status-text">{status}</span>
        <button
          type="button"
          className="update-status-close"
          aria-label={
            preparing ? "Hide update progress" : "Dismiss update status"
          }
          onClick={onDismiss}
        >
          <IconCrossSmall size={12} aria-hidden />
        </button>
      </div>
      {progress ? (
        <div className="update-progress" aria-hidden>
          <div className="update-progress-track">
            <div
              className="update-progress-fill"
              style={{ width: progressWidth }}
            />
          </div>
          {percent !== undefined ? (
            <span className="update-progress-percent">{percent}%</span>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function updateProgressPercent(progress: UpdateInstallProgress | null) {
  if (!progress?.contentLength || progress.contentLength <= 0) return undefined;
  return Math.min(
    100,
    Math.round(
      ((progress.downloadedBytes ?? 0) / progress.contentLength) * 100,
    ),
  );
}

function updateVersionLabel(version: string) {
  return version.startsWith("v") ? version : `v${version}`;
}

// Sidebar toggle icon. One static panel with a single divider that animates:
// expanded it's a full-height line at x=9, collapsed it slides left to x=7 and
// shrinks to a short centered bar — the same glyph the two central-icons draw,
// but tweened via a transform on the divider so it visibly moves between states.
// The collapsed transform is driven by `aria-pressed` on the parent button.
function SidebarToggleGlyph() {
  return (
    <svg
      className="sidebar-toggle-glyph"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M3 8C3 6.34315 4.34315 5 6 5H18C19.6569 5 21 6.34315 21 8V16C21 17.6569 19.6569 19 18 19H6C4.34315 19 3 17.6569 3 16V8Z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <line
        className="sidebar-toggle-divider"
        x1={9}
        y1={5}
        x2={9}
        y2={19}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

function handleTitlebarPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
  if (event.button !== 0 || event.detail > 1) return;
  event.preventDefault();
  void getCurrentWindow()
    .startDragging()
    .catch((error: unknown) =>
      console.warn("Failed to start window drag", error),
    );
}

function isDeniedPermission(state?: string) {
  return state === "denied" || state === "restricted";
}

// Accessibility is a plain bool from the helper (AXIsProcessTrusted),
// surfaced as "granted" | "missing" — not the mic's denied/restricted
// vocabulary. Treat any known non-granted value as blocked so the paste
// permission banner actually shows when access is missing. Undefined stays
// non-blocking so the banner doesn't flash before the helper's first report.
export function isAccessibilityBlocked(state?: string) {
  return state !== undefined && state !== "granted";
}

function isNewSessionShortcut(event: KeyboardEvent) {
  return event.key.toLowerCase() === "n" && isPrimaryShortcut(event);
}

function isCreateNoteShortcut(event: KeyboardEvent) {
  // Primary modifier + Shift + N. isPrimaryShortcut rejects Shift, so check
  // the primary modifier with Shift masked off, then require Shift on top.
  return (
    event.key.toLowerCase() === "n" &&
    event.shiftKey &&
    isPrimaryShortcut({
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: false,
    })
  );
}

function stringPayloadValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function recordingToStatus(recording: {
  id: string;
  noteId?: string;
  sourceMode?: RecordingStatusDto["sourceMode"];
  state: RecordingStatusDto["state"];
  elapsedMs: number;
  level: RecordingStatusDto["level"];
  livePreviewEnabled?: RecordingStatusDto["livePreviewEnabled"];
  sources?: RecordingStatusDto["sources"];
  warnings?: RecordingStatusDto["warnings"];
}): RecordingStatusDto {
  return {
    sessionId: recording.id,
    noteId: recording.noteId,
    sourceMode: recording.sourceMode,
    state: recording.state,
    elapsedMs: recording.elapsedMs,
    level: recording.level,
    silenceWarning: false,
    bytesWritten: 0,
    livePreviewEnabled: recording.livePreviewEnabled ?? false,
    sources: recording.sources,
    warnings: recording.warnings,
  };
}

function startingRecordingStatus(
  noteId: string,
  sourceMode: RecordingSourceMode,
): RecordingStatusDto {
  const sources: RecordingStatusDto["sources"] = [
    {
      source: "microphone",
      state: "starting",
      elapsedMs: 0,
      bytesWritten: 0,
      level: { peak: 0, rms: 0, recentPeaks: [] },
      silenceWarning: false,
      pathFinalized: false,
    },
  ];
  if (sourceMode === "microphonePlusSystem") {
    sources.push({
      source: "system",
      state: "starting",
      elapsedMs: 0,
      bytesWritten: 0,
      level: { peak: 0, rms: 0, recentPeaks: [] },
      silenceWarning: false,
      pathFinalized: false,
    });
  }

  return {
    sessionId: "",
    noteId,
    sourceMode,
    state: "starting",
    elapsedMs: 0,
    level: { peak: 0, rms: 0, recentPeaks: [] },
    silenceWarning: false,
    bytesWritten: 0,
    livePreviewEnabled: false,
    sources,
    warnings: [],
  };
}

// Dev-only helper: pass `?fake-recovery=1` in the URL to inject a fake
// recoverable recording so the inline recovery prompt can be iterated
// on without crashing a real recording. No-op in production builds.
function withFakeRecovery(payload: BootstrapResponse): {
  payload: BootstrapResponse;
  fakeNote?: NoteDto;
} {
  if (!import.meta.env.DEV) return { payload };
  let enabled = false;
  try {
    enabled =
      new URLSearchParams(window.location.search).get("fake-recovery") ===
        "1" ||
      window.location.hash.toLowerCase() === "#fake-recovery" ||
      localStorage.getItem("os-scribe:dev:fake-recovery") === "1";
  } catch {
    return { payload };
  }
  if (!enabled) return { payload };

  const noteId = "fake-recovery-note";
  const sessionId = "fake-recovery-session";
  const now = new Date().toISOString();
  const fakeListItem = {
    id: noteId,
    title: "Team sync",
    preview: "Recovered from an interrupted recording",
    processingStatus: "recoverable" as const,
    folderIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const fakeNote: NoteDto = {
    ...fakeListItem,
    generatedContent: "",
    editedContent: "",
  };
  return {
    payload: {
      ...payload,
      notes: [fakeListItem, ...payload.notes],
      activeRecoveries: [
        {
          sessionId,
          noteId,
          sourceMode: "microphonePlusSystem",
          startedAt: now,
          partialPathPresent: true,
          finalPathPresent: false,
          bytesFound: 2_400_000,
          sources: [
            {
              source: "microphone",
              partialPathPresent: true,
              finalPathPresent: false,
              bytesFound: 1_200_000,
            },
            {
              source: "system",
              partialPathPresent: true,
              finalPathPresent: false,
              bytesFound: 1_200_000,
            },
          ],
        },
        ...payload.activeRecoveries,
      ],
    },
    fakeNote,
  };
}

function isAppErrorCode(err: unknown, code: string) {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    String((err as { code: unknown }).code) === code
  );
}
