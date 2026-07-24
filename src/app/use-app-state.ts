import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { markAgentNewSessionPending } from "../components/agent/session-persistence";
import type { AgentSessionsListHandle } from "../components/agent/AgentSessionsList";
import type { NotesListHandle } from "../components/notes-list/NotesList";
import type { SettingsTab } from "../components/settings/AppSettings";
import type { SidebarView } from "../components/sidebar/Sidebar";
import { defaultNav, makeTabId, type Tab, type TabNav } from "./tabs/tabs";
import type { LiveTranscriptEventDto } from "../lib/tauri";
import { isMacLikePlatform, isWindowsPlatform } from "../lib/platform";
import type { AgentSessionStatusDetail } from "../lib/agent-events";
import { useCurrentDataPartitionName } from "../lib/data-partition";
import type { SessionProfileMap } from "../lib/session-profile-filter";
import type { RecordingInactivityTracker } from "../lib/recording-inactivity";
import {
  createRecordingTelemetryStore,
  type RecordingTelemetryStore,
} from "../lib/recording-telemetry-store";
import { getAgentHudEnabled } from "../lib/agent-hud-settings";
import type { NoteDto } from "../lib/tauri";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import type { RecordingSourceMode, RecordingSourceReadinessDto } from "../lib/tauri";
import { useAccountStatus } from "../lib/account-status";
import { shouldReplayOnboarding } from "../lib/onboarding";
import type { JuneUpdate } from "../lib/updater";
import { createInitialState, notesReducer } from "./state/app-state";
import {
  INITIAL_UPDATE_STATUS_DISPLAY,
  updateStatusDisplayReducer,
  type UpdateInstallProgress,
  type UpdatePromptPayload,
} from "./update-decision";
import { SIDEBAR_DEFAULT_WIDTH, type RecordingInactivityPrompt } from "./app-shell";

export function useAppState() {
  const replayOnboarding = shouldReplayOnboarding();
  const currentDataPartitionName = useCurrentDataPartitionName();
  const startsOnAgent = isMacLikePlatform() || isWindowsPlatform();
  const [profileDataRefreshRevision, setProfileDataRefreshRevision] = useState(0);
  const [state, dispatch] = useReducer(notesReducer, undefined, createInitialState);
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarTransition, setSidebarTransition] = useState<"none" | "smooth">("none");
  const [bootstrapped, setBootstrapped] = useState(false);
  // Supported release platforms launch on a fresh agent session. Keep Linux's
  // existing Notes default until it becomes a supported desktop target.
  const [activeView, setActiveView] = useState<SidebarView>(() => {
    if (!startsOnAgent) return "notes";
    markAgentNewSessionPending();
    return "agent";
  });
  const activeViewRef = useRef<SidebarView>(activeView);
  activeViewRef.current = activeView;
  // Browser-style tabs. Each tab is a saved navigation snapshot; the active tab
  // mirrors live navigation (so a single tab behaves exactly like before),
  // while switching or opening a tab restores its snapshot. The first tab
  // matches the launch view.
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: makeTabId(), nav: startsOnAgent ? defaultNav() : { view: "notes" } },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]!.id);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  // Set while restoring a tab's snapshot into live state: the capture effect
  // skips writes until live navigation settles onto the target (note loads are
  // async), so a half-applied snapshot never overwrites the tab it came from.
  const restoreTargetRef = useRef<TabNav | null>(null);
  // Reactive copy of the known agent sessions for the "view all" list and
  // project (folder) surfaces; the menu-bar refs below stay the source for
  // native menu state.
  const [agentSessions, setAgentSessions] = useState<AgentSessionDto[]>([]);
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<string>();
  const activeAgentSessionIdRef = useRef(activeAgentSessionId);
  activeAgentSessionIdRef.current = activeAgentSessionId;
  const [activeAgentSessionSeed, setActiveAgentSessionSeed] = useState<AgentSessionDto>();
  const setActiveAgentSession = useCallback((session: AgentSessionDto | undefined) => {
    setActiveAgentSessionId(session?.id);
    setActiveAgentSessionSeed(session);
  }, []);
  const [agentWorkingSessionIds, setAgentWorkingSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [agentWaitingSessionIds, setAgentWaitingSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // sessionId -> project (folder) ids. Sessions live in the retired runtime, so their
  // project assignments are tracked separately from the notes state.
  const [sessionFolders, setSessionFolders] = useState<Record<string, string[]>>({});
  // stored the retired runtime session id -> completed_at ISO. June-owned; see JUN-203.
  const [completedSessions, setCompletedSessions] = useState<Record<string, string>>({});
  // In-flight completion writes per stored session id, so rapid toggles for one
  // session persist in the order the user made them (see
  // handleToggleSessionCompleted).
  const sessionCompletionWritesRef = useRef(new Map<string, Promise<unknown>>());
  // Stored session ids the user has toggled locally. The initial load is a
  // snapshot of the pre-toggle database, so those ids must survive it, while
  // every other row it carries still applies (see the boot effect).
  const sessionCompletionTouchedRef = useRef(new Set<string>());
  // Mirrors `completedSessions` for the menu-bar publisher, which is a stable
  // callback and so cannot close over the state directly.
  const completedSessionsRef = useRef<Record<string, string>>({});
  // `null` means the mapping has never loaded. An empty object is meaningful:
  // it confirms every unmapped the retired runtime session belongs to Default. Keeping
  // those states distinct lets failed reads retain a known-good map while the
  // first failure exposes no sessions at all.
  const sessionProfilesRef = useRef<SessionProfileMap | null>(null);
  const [moveDialogSessionIds, setMoveDialogSessionIds] = useState<string[] | null>(null);
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
    profile: string;
  } | null>(null);
  const agentMenuBarSessionsRef = useRef<AgentSessionDto[]>([]);
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
  const [settingsReturnView, setSettingsReturnView] = useState<SidebarView>("notes");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  // When the Memory tab is opened from a project ("Manage memories"), the
  // manager pre-filters to that project. Cleared on any normal tab navigation.
  const [memoryFolderFilter, setMemoryFolderFilter] = useState<string | undefined>();
  const openSettings = useCallback(() => {
    const returnView = activeViewRef.current;
    if (returnView !== "settings") {
      setSettingsReturnView(returnView);
    }
    setMemoryFolderFilter(undefined);
    setActiveView("settings");
  }, []);
  // Deep-link into Settings > Memory filtered to a project (from the project
  // settings dialog's "Manage memories").
  const openMemorySettings = useCallback((folderId?: string) => {
    const returnView = activeViewRef.current;
    if (returnView !== "settings") {
      setSettingsReturnView(returnView);
    }
    setMemoryFolderFilter(folderId);
    setSettingsTab("memory");
    setActiveView("settings");
  }, []);
  // Any deliberate tab change clears the project pre-filter so opening Memory
  // from the settings nav shows all memories, not a stale project scope.
  const changeSettingsTab = useCallback((tab: SettingsTab) => {
    setMemoryFolderFilter(undefined);
    setSettingsTab(tab);
  }, []);
  const [originFolderId, setOriginFolderId] = useState<string | undefined>();
  // Tracks that the open note was drilled into from the All notes view, so the
  // note shows the same back-arrow + breadcrumb chrome folders use. Cleared
  // whenever a note is opened from anywhere else (e.g. the sidebar list).
  const [originAllNotes, setOriginAllNotes] = useState(false);
  const [folderReturnTarget, setFolderReturnTarget] = useState<
    { noteId: string; label: string } | undefined
  >();
  const [moveDialogNoteIds, setMoveDialogNoteIds] = useState<string[] | null>(null);
  // User's intent for system audio. Defaults true ("record everything").
  // The actual sourceMode is derived below so that granting/revoking
  // permission in System Settings flips the toggle without losing intent.
  const [userWantsSystemAudio, setUserWantsSystemAudio] = useState(true);
  const [sourceReadiness, setSourceReadiness] = useState<RecordingSourceReadinessDto>();
  const [checkingSourceReadiness, setCheckingSourceReadiness] = useState(false);
  const [accessibilityStatus, setAccessibilityStatus] = useState<string>();
  const [accessibilityBannerDismissed, setAccessibilityBannerDismissed] = useState(false);
  const [systemAudioRefreshRequest, setSystemAudioRefreshRequest] = useState(0);
  const [microphoneStatus, setMicrophoneStatus] = useState<string>();
  const [readyUpdate, setReadyUpdate] = useState<UpdatePromptPayload<JuneUpdate> | null>(null);
  const [updateStatusDisplay, dispatchUpdateStatusDisplay] = useReducer(
    updateStatusDisplayReducer,
    INITIAL_UPDATE_STATUS_DISPLAY,
  );
  const updateStatus = updateStatusDisplay.status;
  const updateStatusLeaving = updateStatusDisplay.leaving;
  const setUpdateStatus = useCallback((status: string | null, failed = false) => {
    dispatchUpdateStatusDisplay({ type: "show", status, failed });
  }, []);
  const [preparingUpdate, setPreparingUpdate] = useState(false);
  // Render-only flag for a visible manual check. checkingUpdateRef separately
  // guards every check mode, including silent launch and periodic checks.
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [relaunchingUpdate, setRelaunchingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateInstallProgress | null>(null);
  // `ready` only says this device is capable of system capture; the platform
  // grant/status is established by a microphone-plus-system probe.
  const systemSourceReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "system",
  );
  const systemGranted =
    systemSourceReadiness?.ready === true && systemSourceReadiness.permissionState === "granted";
  const recordingState = state.recordingStatus?.state;
  const captureActive =
    recordingState === "recording" ||
    recordingState === "paused" ||
    recordingState === "finalizing" ||
    recordingState === "validating";
  const sourceMode: RecordingSourceMode =
    userWantsSystemAudio && systemGranted ? "microphonePlusSystem" : "microphoneOnly";
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
  // A recording may deliberately keep its owning note visible after the user
  // switches profiles. Remember that exception so stopping the take can remove
  // the old-profile note and its tab snapshots immediately.
  const crossProfileRecordingNoteIdRef = useRef<string | undefined>(undefined);
  // Calendar matching finishes in the background and emits a global event.
  // Remember which profile started each lookup so a late result cannot upsert
  // an old-profile note into whichever profile is visible when it arrives.
  const calendarContextNoteProfilesRef = useRef(new Map<string, string>());
  const calendarContextNoteUpdatesRef = useRef(new Map<string, NoteDto>());
  const pendingCalendarContextAdoptionsRef = useRef(new Set<string>());
  // Reactive mirror of recordingNoteIdRef. The ref serves the async finish/HUD
  // paths that need the latest value synchronously; this state drives render
  // decisions — which note shows the in-note RecorderBar, and whether the
  // floating global recorder pill is up (it shows whenever a recording is live
  // but you're not viewing its note). Always update them together via
  // setRecordingNote so they can't drift.
  const [recordingNoteId, setRecordingNoteIdState] = useState<string | undefined>(undefined);
  const recordingStatusRef = useRef(state.recordingStatus);
  const recordingTelemetryStoreRef = useRef<RecordingTelemetryStore | null>(null);
  if (!recordingTelemetryStoreRef.current) {
    recordingTelemetryStoreRef.current = createRecordingTelemetryStore(state.recordingStatus);
  }
  const recordingTelemetryStore = recordingTelemetryStoreRef.current;
  const dictationWorkflowActiveRef = useRef(false);
  const recordingInactivityTrackerRef = useRef<RecordingInactivityTracker>({});
  const [recordingInactivityPrompt, setRecordingInactivityPrompt] =
    useState<RecordingInactivityPrompt | null>(null);
  const [recordingInactivityNow, setRecordingInactivityNow] = useState(() => Date.now());
  const recordingStartInFlightRef = useRef(false);
  const [liveTranscriptEvents, setLiveTranscriptEvents] = useState<LiveTranscriptEventDto[]>([]);
  useEffect(() => {
    recordingStatusRef.current = state.recordingStatus;
    recordingTelemetryStore.setStatus(state.recordingStatus);
  }, [recordingTelemetryStore, state.recordingStatus]);
  const setRecordingNote = useCallback((noteId: string | undefined) => {
    recordingNoteIdRef.current = noteId;
    setRecordingNoteIdState(noteId);
  }, []);

  return {
    currentDataPartitionName,
    profileDataRefreshRevision,
    setProfileDataRefreshRevision,
    state,
    dispatch,
    error,
    setError,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarWidth,
    setSidebarWidth,
    sidebarResizing,
    setSidebarResizing,
    sidebarTransition,
    setSidebarTransition,
    bootstrapped,
    setBootstrapped,
    activeView,
    setActiveView,
    activeViewRef,
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    tabsRef,
    activeTabIdRef,
    restoreTargetRef,
    agentSessions,
    setAgentSessions,
    activeAgentSessionId,
    setActiveAgentSessionId,
    activeAgentSessionIdRef,
    activeAgentSessionSeed,
    setActiveAgentSessionSeed,
    setActiveAgentSession,
    agentWorkingSessionIds,
    setAgentWorkingSessionIds,
    agentWaitingSessionIds,
    setAgentWaitingSessionIds,
    sessionFolders,
    setSessionFolders,
    completedSessions,
    setCompletedSessions,
    sessionCompletionWritesRef,
    sessionCompletionTouchedRef,
    completedSessionsRef,
    sessionProfilesRef,
    moveDialogSessionIds,
    setMoveDialogSessionIds,
    agentOrigin,
    setAgentOrigin,
    pendingSessionProjectRef,
    agentMenuBarSessionsRef,
    agentMenuBarWorkingSessionIdsRef,
    agentMenuBarWaitingSessionIdsRef,
    agentMenuBarLastStatusRef,
    agentHudEnabledRef,
    mainPanelBodyRef,
    noteDetailScrollRef,
    notesListRef,
    agentSessionsListRef,
    settingsReturnView,
    setSettingsReturnView,
    settingsTab,
    setSettingsTab,
    memoryFolderFilter,
    openSettings,
    openMemorySettings,
    changeSettingsTab,
    originFolderId,
    setOriginFolderId,
    originAllNotes,
    setOriginAllNotes,
    folderReturnTarget,
    setFolderReturnTarget,
    moveDialogNoteIds,
    setMoveDialogNoteIds,
    setUserWantsSystemAudio,
    sourceReadiness,
    setSourceReadiness,
    checkingSourceReadiness,
    setCheckingSourceReadiness,
    accessibilityStatus,
    setAccessibilityStatus,
    accessibilityBannerDismissed,
    setAccessibilityBannerDismissed,
    systemAudioRefreshRequest,
    setSystemAudioRefreshRequest,
    microphoneStatus,
    setMicrophoneStatus,
    readyUpdate,
    setReadyUpdate,
    updateStatusDisplay,
    dispatchUpdateStatusDisplay,
    updateStatus,
    updateStatusLeaving,
    setUpdateStatus,
    preparingUpdate,
    setPreparingUpdate,
    checkingUpdate,
    setCheckingUpdate,
    relaunchingUpdate,
    setRelaunchingUpdate,
    updateProgress,
    setUpdateProgress,
    systemGranted,
    captureActive,
    sourceMode,
    account,
    accountError,
    accountLoading,
    refreshAccount,
    setAccount,
    recordingNoteIdRef,
    crossProfileRecordingNoteIdRef,
    calendarContextNoteProfilesRef,
    calendarContextNoteUpdatesRef,
    pendingCalendarContextAdoptionsRef,
    recordingNoteId,
    recordingTelemetryStore,
    recordingStatusRef,
    dictationWorkflowActiveRef,
    recordingInactivityTrackerRef,
    recordingInactivityPrompt,
    setRecordingInactivityPrompt,
    recordingInactivityNow,
    setRecordingInactivityNow,
    recordingStartInFlightRef,
    liveTranscriptEvents,
    setLiveTranscriptEvents,
    setRecordingNote,
  };
}
