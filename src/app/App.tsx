import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AccountGate, AccountStatusFailure } from "../components/account/AccountGate";
import { FundingChip, FundingNotice, fundingTierOf } from "../components/account/FundingNotice";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSION_RENAMED_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  AgentWorkspace,
  markAgentNewSessionPending,
  recordManualAgentSessionTitle,
  type AgentNewSessionDetail,
  type AgentSessionRenamedDetail,
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
import { NoteHeaderActions } from "../components/note-editor/NoteHeaderActions";
import { toast } from "../components/ui/Toaster";
import { exportNoteAsPdf } from "../lib/note-pdf";
import { NoteChatPanel } from "../components/note-chat/NoteChatPanel";
import { useNoteChat } from "../components/note-chat/useNoteChat";
import { ShareDialog } from "../components/share/ShareDialog";
import { ShareLinkCopyAction } from "../components/share/ShareLinkCopyAction";
import { buildNotePayload, noteReadyToShare } from "../lib/share-payload";
import { GlobalRecorderPill } from "../components/recorder/GlobalRecorderPill";
import type { GlobalRecorderDemoApi } from "../lib/global-recorder-demo";
import type { RecordNoticesDemoApi } from "../lib/record-notices-demo";
import type { UpdateCardDemoApi } from "../lib/update-card-demo";
import { NotesList, type NotesListHandle } from "../components/notes-list/NotesList";
import { PermissionBanner } from "../components/permissions/PermissionBanner";
import { AppSettings, SETTINGS_TABS, type SettingsTab } from "../components/settings/AppSettings";
import { Sidebar, type SidebarView } from "../components/sidebar/Sidebar";
import { TabBar, type TabItem } from "../components/tabs/TabBar";
import {
  defaultNav,
  invalidateNoteTabs,
  makeTabId,
  navEquals,
  reorderTabs,
  type Tab,
  type TabNav,
} from "./tabs/tabs";
import { BreadcrumbBar } from "../components/ui/BreadcrumbBar";
import { IconProjects } from "central-icons/IconProjects";
import { ConnectorApprovalsTray } from "../components/connectors/ConnectorApprovalsTray";
import { ComputerUseApprovalsTray } from "../components/agent/ComputerUseApprovalsTray";
import {
  OPEN_REFERRAL_DIALOG_EVENT,
  ReferralNudge,
  type ReferralNudgeMoment,
} from "../components/referral/ReferralNudge";
import { markReferralNudgeClickedThrough, recordDictationFinished } from "../lib/referral-nudge";
import { useReferralNudgeTriggers } from "./referral-nudge-triggers";
import { Dialog } from "../components/ui/Dialog";
import { Spinner } from "../components/ui/Spinner";
import {
  acknowledgeMeetingStartRequest,
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
  downloadNoteAudio,
  ensureHermesBridgeSession,
  finishRecording,
  getRecordingStatus,
  getNote,
  LIVE_TRANSCRIPT_EVENT,
  NOTE_CALENDAR_CONTEXT_UPDATED_EVENT,
  listCompletedSessions,
  listFolders,
  listNotes,
  listSessionFolders,
  listSessionProfiles,
  openPrivacySettings,
  osAccountsLogout,
  osAccountsOpenPortal,
  pauseRecording,
  pendingMeetingStartRequest,
  removeNoteFromFolder,
  removeSessionFromFolder,
  recoverRecording,
  revealPath,
  renameFolder,
  resolveAgentRecorderRequest,
  resumeRecording,
  retryProcessing,
  setSessionCompleted,
  startMeetingRecording,
  startRecording,
  updateNote,
  agentHudHide,
  agentHudShow,
  agentOpenReady,
  sendAppNotification,
  type LiveTranscriptEventDto,
} from "../lib/tauri";
import { playRecordingSound, preloadRecordingSounds } from "../lib/recording-sounds";
import { preloadAgentSounds } from "../lib/agent-sounds";
import { isMacLikePlatform, isPrimaryShortcut, isWindowsPlatform } from "../lib/platform";
import { mergeSourceReadiness } from "../lib/source-readiness";
import { AGENT_RECORDER_REQUEST_EVENT, MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import {
  AGENT_GALLERY_EVENT,
  AGENT_OPEN_EVENT,
  AGENT_RUN_SETTLED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  dispatchAgentSessionStatus,
  emitAgentSessionsChanged,
  type AgentGalleryDetail,
  type AgentRunSettledDetail,
  type AgentSessionStatusDetail,
} from "../lib/agent-events";
import { selectSessionProjectContext } from "../lib/agent-project-context";
import {
  notifyAgentRunSettled,
  notifyAgentSessionStatus,
  type AgentAttentionContext,
} from "../lib/agent-notifications";
import { getAgentSoundsEnabled } from "../lib/agent-sound-settings";
import { rememberSessionManuallyTitled } from "../lib/agent-session-titles";
import { errorCode, messageFromError } from "../lib/errors";
import { nextDictationWorkflowActive, parseDictationHelperEvent } from "../lib/dictation-events";
import {
  listHermesSessions,
  listScheduledRunSessions,
  titleFromPrompt,
} from "../lib/hermes-adapter";
import {
  createSingleFlight,
  loadRoutineRunWatchState,
  markRunsNotified,
  routineRunWatchStep,
  saveRoutineRunWatchState,
} from "../lib/routine-run-notifications";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import {
  getActiveHermesProfileName,
  PROFILE_DATA_CHANGED_EVENT,
  useActiveHermesProfileName,
  type ProfileDataChangedDetail,
} from "../lib/active-hermes-profile";
import {
  filterAgentSessionsForProfile,
  sessionProfileMap,
  type SessionProfileMap,
} from "../lib/session-profile-filter";
import {
  authoritativeTranscriptCoverageKey,
  clearTerminalLiveTranscriptEvents,
  upsertLiveTranscriptEvent,
} from "../lib/live-transcript-preview";
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
import { applyAutostartDefaultOnce, retryPendingAutostartDefault } from "../lib/autostart";
import {
  applyOnboardingReplayFlag,
  hasCompletedAnyOnboardingVersion,
  isOnboardingComplete,
  markOnboardingComplete,
  shouldReplayOnboarding,
} from "../lib/onboarding";
import {
  depletedBalanceAction,
  depletedBalanceActionLabel,
  shouldBlockOnFunding,
  shouldBlockOnSignIn,
} from "../lib/account-gate";
import {
  type DepletedBalanceOutcome,
  type MaxUpgradeTransport,
  runDepletedBalanceAction,
} from "../lib/billing-actions";
import {
  MAX_GRANT_HOSTED_POLL_TIMEOUT_MS,
  MAX_UPGRADE_BROWSER_STATUS,
  MAX_UPGRADE_BUSY_LABEL,
  MAX_UPGRADE_CHARGE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_LABEL,
  MAX_UPGRADE_CONFIRM_TITLE,
  MAX_UPGRADE_PORTAL_LABEL,
  MAX_UPGRADE_READY_STATUS,
  MAX_UPGRADE_STALE_ACTION_NOTICE,
  MAX_UPGRADE_WAITING_STATUS,
  type MaxGrantWait,
  accountLooksPreGrant,
  beginMaxGrantWait,
  clearMaxGrantWait,
  isMaxGrantWaitCurrent,
  isMaxUpgradeWaitStatus,
  markMaxGrantWaitSlow,
  markMaxGrantWaitWaiting,
  maxGrantLanded,
  maxGrantWaitForAccount,
  maxUpgradeSlowStatus,
  maxUpgradeWaitStatus,
  pollForMaxGrant,
} from "../lib/max-upgrade";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { checkJuneUpdate, reconcileToStable, relaunchJune, type JuneUpdate } from "../lib/updater";
import {
  PROCESSING_DEMO_NOTE_ID,
  RECORD_NOTICES_DEMO_SESSION_ID,
  shouldPollProcessingStatus,
} from "./processing-polling";
import { attachScrollThumbFade } from "../lib/scroll-thumb-fade";
import { createInitialState, notesReducer } from "./state/app-state";
import { handleSidebarResizeStart } from "./sidebar-resize";
import {
  checkForJuneUpdate,
  INITIAL_UPDATE_STATUS_DISPLAY,
  prepareJuneUpdate,
  startPeriodicJuneUpdateChecks,
  UP_TO_DATE_STATUS,
  updateCheckShowsStatus,
  updateStatusDisplayReducer,
  type UpdateCheckMode,
  type UpdateInstallProgress,
  type UpdatePromptPayload,
} from "./update-decision";
import { UpdateHub, updateMenuBarSessionStatus } from "./app-effects/update-ui";
import {
  SidebarToggleGlyph,
  handleTitlebarPointerDown,
  isAccessibilityBlocked,
  isAppErrorCode,
  isCreateNoteShortcut,
  isMicrophoneRecordingBlocked,
  isNewSessionShortcut,
  recordingToStatus,
  revealMainWindowForMeetingStartError,
  startingRecordingStatus,
  stringPayloadValue,
  withFakeRecovery,
} from "./app-helpers";
export { isAccessibilityBlocked, isMicrophoneRecordingBlocked } from "./app-helpers";
import {
  ACCESSIBILITY_PERMISSION_REFRESH_INTERVAL_MS,
  AGENT_MENU_BAR_SESSION_FETCH_LIMIT,
  AGENT_MENU_BAR_SESSION_LIMIT,
  AGENT_MENU_BAR_SESSION_RETRY_DELAYS_MS,
  CHECK_FOR_UPDATES_EVENT,
  COMPOSER_FUNDING_DISABLED_REASON,
  MEETING_START_LISTENER_RETRY_DELAYS_MS,
  MEETING_START_REQUEST_EXPIRED_MESSAGE,
  NOTE_RETRY_FUNDING_DISABLED_REASON,
  RECOVERY_FUNDING_DISABLED_REASON,
  RECORDING_FUNDING_DISABLED_REASON,
  ROUTINE_FUNDING_DISABLED_REASON,
  ROUTINE_RUN_NOTIFY_POLL_MS,
  SIDEBAR_COLLAPSE_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SYSTEM_AUDIO_PERMISSION_REFRESH_INTERVAL_MS,
  SYSTEM_AUDIO_PERMISSION_REFRESH_TIMEOUT_MS,
  UP_TO_DATE_DISMISS_MS,
  UP_TO_DATE_EXIT_MS,
  agentSessionTabTitle,
  noteHasDownloadableAudio,
  refreshedTabNav,
  sidebarMaxWidth,
  tabMeta,
  type AgentRecorderRequestPayload,
  type RecordingInactivityPrompt,
} from "./app-shell";

import { useAppExternalEvents } from "./use-app-external-events";

import { useAgentAttentionNotifications } from "./use-agent-attention-notifications";

import { useAgentMenuSessions } from "./use-agent-menu-sessions";

export function App() {
  const replayOnboarding = shouldReplayOnboarding();
  const activeHermesProfileName = useActiveHermesProfileName();
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
  const [agentSessions, setAgentSessions] = useState<HermesSessionInfo[]>([]);
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<string>();
  const activeAgentSessionIdRef = useRef(activeAgentSessionId);
  activeAgentSessionIdRef.current = activeAgentSessionId;
  const [activeAgentSessionSeed, setActiveAgentSessionSeed] = useState<HermesSessionInfo>();
  const setActiveAgentSession = useCallback((session: HermesSessionInfo | undefined) => {
    setActiveAgentSessionId(session?.id);
    setActiveAgentSessionSeed(session);
  }, []);
  const [agentWorkingSessionIds, setAgentWorkingSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [agentWaitingSessionIds, setAgentWaitingSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // sessionId -> project (folder) ids. Sessions live in Hermes, so their
  // project assignments are tracked separately from the notes state.
  const [sessionFolders, setSessionFolders] = useState<Record<string, string[]>>({});
  // stored Hermes session id -> completed_at ISO. June-owned; see JUN-203.
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
  // it confirms every unmapped Hermes session belongs to Default. Keeping
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
  const dictationWorkflowActiveRef = useRef(false);
  const recordingInactivityTrackerRef = useRef<RecordingInactivityTracker>({});
  const [recordingInactivityPrompt, setRecordingInactivityPrompt] =
    useState<RecordingInactivityPrompt | null>(null);
  const [recordingInactivityNow, setRecordingInactivityNow] = useState(() => Date.now());
  const recordingStartInFlightRef = useRef(false);
  const [liveTranscriptEvents, setLiveTranscriptEvents] = useState<LiveTranscriptEventDto[]>([]);
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
  const [demoRecorderStatus, setDemoRecorderStatus] = useState<RecordingStatusDto | null>(null);
  const demoRecorderRef = useRef<GlobalRecorderDemoApi | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("../lib/global-recorder-demo").then(({ registerGlobalRecorderDemo }) => {
      if (cancelled) return;
      demoRecorderRef.current = registerGlobalRecorderDemo({
        setStatus: setDemoRecorderStatus,
      });
    });
    return () => {
      cancelled = true;
      demoRecorderRef.current?.dispose();
      demoRecorderRef.current = null;
    };
  }, []);
  // Dev-only console driver (window.__processingDemo) that seeds a synthetic
  // meeting note parked in a transcription-processing stage so the
  // ProcessingProgressIndicator can be inspected without a real recording.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/processing-progress-demo").then(({ registerProcessingProgressDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerProcessingProgressDemo({
        seedNote: (note) => {
          dispatch({ type: "noteLoaded", note });
          setActiveView("meetings");
        },
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  // Dev-only console driver (window.__recordNoticesDemo) that parks the
  // recorder-area notices (consent reminder, source warning, mic-blocked) on the
  // selected note without a real recording, so their styling can be inspected.
  // The synthetic status runs under RECORD_NOTICES_DEMO_SESSION_ID, which the
  // status poll and the pause/resume/finish handlers skip so no backend call
  // fires; consent pinning bypasses the recorder bar's reveal/auto-hide timers.
  const [recordNoticesConsentPinned, setRecordNoticesConsentPinned] = useState(false);
  const [recordNoticesMicOverride, setRecordNoticesMicOverride] = useState<boolean | null>(null);
  const recordNoticesDemoRef = useRef<RecordNoticesDemoApi | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("../lib/record-notices-demo").then(({ registerRecordNoticesDemo }) => {
      if (cancelled) return;
      recordNoticesDemoRef.current = registerRecordNoticesDemo({
        seedNote: (note) => {
          dispatch({ type: "noteLoaded", note });
          setActiveView("meetings");
        },
        setStatus: (status) => {
          // Defense in depth: never let the demo's synthetic status stomp a real
          // recording, even if the driver's hasRealRecording check somehow raced.
          const active = recordingStatusRef.current;
          if (active && active.sessionId !== RECORD_NOTICES_DEMO_SESSION_ID) return;
          if (status) {
            dispatch({ type: "recordingStatusChanged", status });
            setRecordingNote(status.noteId);
          } else {
            dispatch({ type: "recordingStatusCleared" });
            setRecordingNote(undefined);
            setLiveTranscriptEvents([]);
          }
        },
        setConsentPinned: setRecordNoticesConsentPinned,
        setMicOverride: setRecordNoticesMicOverride,
        getSelectedNoteId: () => selectedNoteIdRef.current,
        hasRealRecording: () => {
          const active = recordingStatusRef.current;
          return !!active && active.sessionId !== RECORD_NOTICES_DEMO_SESSION_ID;
        },
      });
    });
    return () => {
      cancelled = true;
      recordNoticesDemoRef.current?.dispose();
      recordNoticesDemoRef.current = null;
    };
  }, [setRecordingNote]);
  // The referral delight nudge (bottom-left card). Real shows come from the
  // trigger layer (useReferralNudgeTriggers below); the dev console driver
  // (window.__referralNudge) parks the card without touching the persisted
  // caps, which is why the source is tracked — only trigger-shown cards may
  // record a click-through.
  const [referralNudgeMoment, setReferralNudgeMoment] = useState<ReferralNudgeMoment | null>(null);
  const referralNudgeSourceRef = useRef<"trigger" | "demo">("trigger");
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/referral-nudge-demo").then(({ registerReferralNudgeDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerReferralNudgeDemo({
        setMoment: (moment) => {
          referralNudgeSourceRef.current = "demo";
          setReferralNudgeMoment(moment);
        },
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  // Dev console driver for the sidebar update cards (window.__updateCard).
  // Pushes synthetic values into the real update state so each card's styling
  // can be parked and inspected without a live update.
  const updateCardDemoRef = useRef<UpdateCardDemoApi | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("../lib/update-card-demo").then(({ registerUpdateCardDemo }) => {
      if (cancelled) return;
      updateCardDemoRef.current = registerUpdateCardDemo({
        setReadyUpdate,
        setStatus: setUpdateStatus,
        setRelaunching: setRelaunchingUpdate,
        setPreparing: setPreparingUpdate,
        setChecking: setCheckingUpdate,
        setProgress: setUpdateProgress,
      });
    });
    return () => {
      cancelled = true;
      updateCardDemoRef.current?.dispose();
      updateCardDemoRef.current = null;
    };
  }, [setUpdateStatus]);
  // Dev console driver (window.__toastDemo) that fires each toast variant so
  // the toast styling can be inspected without walking a real flow.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/toast-demo").then(({ registerToastDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerToastDemo());
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  // Dev console driver (window.__juneSounds) for hearing the full recording
  // and agent sound family without walking each production lifecycle.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/june-sounds-demo").then(({ registerJuneSoundsDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerJuneSoundsDemo());
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  // Sessions with a finishRecording call in flight; guards stop double-clicks.
  const finishingSessionsRef = useRef<Set<string>>(new Set());
  // A dev build without the OS Accounts env vars (fresh workspace, no .env)
  // can never complete sign-in, so the account gates would be dead
  // ends — skip them and let account-dependent features surface their own
  // errors. Release builds always gate; so do dev builds once configured.
  const devAccountsUnconfigured =
    import.meta.env.DEV &&
    !account.signedIn &&
    (accountLoading || !!accountError || !account.configured);
  const signInRequired = !devAccountsUnconfigured && shouldBlockOnSignIn(account);
  // Dev console driver (window.__fundingDemo) that parks the out-of-credits
  // surfaces (composer notice, sidebar chip) on a synthetic account snapshot
  // so every funding branch can be inspected without a depleted account. The
  // override bypasses the sign-in/unconfigured guards on purpose: the browser
  // sandbox is rarely signed in, and the demo exists precisely there.
  const [fundingDemoAccount, setFundingDemoAccountState] = useState<AccountStatus | null>(null);
  const fundingDemoRef = useRef<AccountStatus | null>(null);
  const setFundingDemoAccount = useCallback((next: AccountStatus | null) => {
    fundingDemoRef.current = next;
    setFundingDemoAccountState(next);
  }, []);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/funding-demo").then(({ registerFundingDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerFundingDemo({ setOverride: setFundingDemoAccount }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [setFundingDemoAccount]);
  const fundingAccount = fundingDemoAccount ?? account;
  const refreshFundingAccount = useCallback(async () => {
    if (fundingDemoRef.current) return fundingDemoRef.current;
    return refreshAccount();
  }, [refreshAccount]);
  const fundingRequired = fundingDemoAccount
    ? shouldBlockOnFunding(fundingDemoAccount)
    : !devAccountsUnconfigured && !signInRequired && shouldBlockOnFunding(account);
  const topUpLabel = depletedBalanceActionLabel(account);
  // Confirm gate for the Pro -> Max plan change reached from depleted-balance
  // surfaces (note failure banner, agent workspace notice). Capture the action
  // at click time so a later account refresh cannot reroute confirmation to a
  // different billing transport. `transport` flips to charge_now only after a
  // hosted capability signal, swapping the dialog to the charge-now copy that
  // the next confirm actually consents to.
  const [maxUpgradePrompt, setMaxUpgradePrompt] = useState<{
    action: "upgrade_to_max";
    plan: "max";
    transport: MaxUpgradeTransport;
  } | null>(null);
  const [maxUpgradeError, setMaxUpgradeError] = useState<string>();
  // Transient billing feedback shown beside the error banner. Success is only
  // announced after the credit grant poll observes a higher credit balance.
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const appMaxGrantWaitRef = useRef<MaxGrantWait>();
  const billingNoticeTimerRef = useRef<number | undefined>(undefined);
  const showBillingNotice = useCallback((notice: string, autoClearMs?: number) => {
    window.clearTimeout(billingNoticeTimerRef.current);
    setBillingNotice(notice);
    if (autoClearMs) {
      billingNoticeTimerRef.current = window.setTimeout(() => setBillingNotice(null), autoClearMs);
    }
  }, []);
  const confirmMaxUpgrade = useCallback(async () => {
    if (!maxUpgradePrompt) return;
    // A wait can begin on another surface while this dialog sits open (an
    // upgrade confirmed in Billing settings). Never stack a second purchase
    // on it; adopt the wait and show its status. A slow wait stays
    // retryable - the dispatch below supersedes it.
    const pendingWait = maxGrantWaitForAccount(account.user?.id);
    if (pendingWait && pendingWait.phase !== "slow") {
      setMaxUpgradePrompt(null);
      appMaxGrantWaitRef.current = pendingWait;
      showBillingNotice(
        pendingWait.phase === "browser" ? MAX_UPGRADE_BROWSER_STATUS : MAX_UPGRADE_WAITING_STATUS,
      );
      return;
    }
    if (depletedBalanceAction(account) !== maxUpgradePrompt.action) {
      // The account reclassified between click and confirm (plan changed,
      // subscription lapsed). Never dispatch the stale intent - and never
      // just vanish: say why the dialog closed.
      setMaxUpgradePrompt(null);
      showBillingNotice(MAX_UPGRADE_STALE_ACTION_NOTICE, 8000);
      return;
    }
    const baselineCredits = account.balance?.credits ?? 0;
    let outcome: DepletedBalanceOutcome;
    try {
      outcome = await runDepletedBalanceAction(
        account,
        maxUpgradePrompt.action,
        maxUpgradePrompt.plan,
        maxUpgradePrompt.transport,
      );
    } catch (err) {
      // Keep the dialog open with the failure inside it, next to retry.
      setMaxUpgradeError(messageFromError(err));
      throw err;
    }
    if (outcome === "charge_confirmation_required") {
      // Definitive capability signal: nothing was charged. Swap the dialog to
      // the charge-now copy and keep it open (ConfirmDialog stays up on a
      // rejection) so the PATCH gets its own explicit confirm.
      setMaxUpgradeError(undefined);
      setMaxUpgradePrompt({ ...maxUpgradePrompt, transport: "charge_now" });
      throw new Error("charge_confirmation_required");
    }
    if (outcome === "already_on_plan") {
      // The server already has the plan. One refresh decides between a grant
      // still landing (poll) and a long-settled Max account, where a poll
      // could never succeed and the surface must re-derive its prompt.
      const refreshed = await refreshAccount();
      if (!accountLooksPreGrant(refreshed, baselineCredits)) {
        // Settled: any wait for this account is obsolete and must not keep
        // suppressing the depleted-balance surfaces. A retry dispatched from
        // a slow wait lands here.
        const staleWait = maxGrantWaitForAccount(account.user?.id);
        if (staleWait) clearMaxGrantWait(staleWait);
        appMaxGrantWaitRef.current = undefined;
        window.clearTimeout(billingNoticeTimerRef.current);
        setBillingNotice(null);
        return;
      }
    } else if (outcome !== "opened_upgrade_session" && outcome !== "changed_plan") {
      // The server no longer sees an active subscription. Refresh and let
      // the depleted-balance surface render the correct subscribe action.
      void refreshAccount();
      return;
    }
    // Hosted confirmation and the credit grant arrive asynchronously. The
    // consented PATCH skips only the browser-confirmation phase; both paths
    // stay neutral until the account refresh poll observes landed credits.
    const hostedReview = outcome === "opened_upgrade_session";
    const grantWait = beginMaxGrantWait(
      baselineCredits,
      account.user?.id,
      hostedReview ? "browser" : "waiting",
    );
    appMaxGrantWaitRef.current = grantWait;
    showBillingNotice(hostedReview ? MAX_UPGRADE_BROWSER_STATUS : MAX_UPGRADE_WAITING_STATUS);
    void pollForMaxGrant(
      refreshAccount,
      baselineCredits,
      hostedReview ? { timeoutMs: MAX_GRANT_HOSTED_POLL_TIMEOUT_MS } : {},
    ).then((landed) => {
      if (!isMaxGrantWaitCurrent(grantWait)) return;
      if (landed) {
        clearMaxGrantWait(grantWait);
        appMaxGrantWaitRef.current = undefined;
        showBillingNotice(MAX_UPGRADE_READY_STATUS, 8000);
      } else {
        markMaxGrantWaitSlow(grantWait);
        showBillingNotice(maxUpgradeSlowStatus(grantWait));
      }
    });
  }, [account, maxUpgradePrompt, refreshAccount, showBillingNotice]);

  useEffect(() => {
    const grantWait = appMaxGrantWaitRef.current;
    if (grantWait && grantWait.accountId !== account.user?.id) {
      clearMaxGrantWait(grantWait);
      appMaxGrantWaitRef.current = undefined;
      window.clearTimeout(billingNoticeTimerRef.current);
      setBillingNotice(null);
      return;
    }
    if (grantWait && !isMaxGrantWaitCurrent(grantWait)) {
      // Cancelled or superseded on a coexisting surface (funding notice,
      // sidebar chip, Billing settings). Drop the cached copy so the banner
      // cannot claim a wait that no longer exists; the surface owning the
      // live wait shows its status, and interaction guards re-adopt it here.
      appMaxGrantWaitRef.current = undefined;
      window.clearTimeout(billingNoticeTimerRef.current);
      setBillingNotice(null);
      return;
    }
    if (grantWait) {
      // A coexisting surface's poll advances the shared wait's phase by
      // in-place mutation, which the identity checks above cannot see. Swap
      // a stale phase line for the live one - and only a phase line, never
      // an error or the ready notice.
      const phaseCopy = maxUpgradeWaitStatus(grantWait);
      setBillingNotice((notice) =>
        notice !== null && notice !== phaseCopy && isMaxUpgradeWaitStatus(notice)
          ? phaseCopy
          : notice,
      );
    }
    if (grantWait?.phase === "browser" && account.subscription?.plan === "max") {
      markMaxGrantWaitWaiting(grantWait);
      showBillingNotice(MAX_UPGRADE_WAITING_STATUS);
    }
    if (!grantWait || !maxGrantLanded(account, grantWait.baselineCredits)) return;
    clearMaxGrantWait(grantWait);
    appMaxGrantWaitRef.current = undefined;
    showBillingNotice(MAX_UPGRADE_READY_STATUS, 8000);
  }, [account, showBillingNotice]);

  const handleTopUp = useCallback(() => {
    // An upgrade already waiting for this account (started here or on any
    // other surface) must never be offered a second purchase: adopt the wait
    // and re-show its status instead of opening a new confirm. A slow wait
    // (an abandoned Stripe page) keeps the retry path - reopening a hosted
    // session charges nothing until the Stripe confirm.
    const pendingWait = maxGrantWaitForAccount(account.user?.id);
    if (pendingWait && pendingWait.phase !== "slow") {
      appMaxGrantWaitRef.current = pendingWait;
      showBillingNotice(
        pendingWait.phase === "browser" ? MAX_UPGRADE_BROWSER_STATUS : MAX_UPGRADE_WAITING_STATUS,
      );
      return;
    }
    // Tier-aware: Max tops up, Pro changes its plan in place, Free subscribes.
    // The Max path routes through an explicit confirmation. A stale top-up
    // gate refreshes the snapshot so the surface can render the right prompt
    // without an automatic purchase.
    const action = depletedBalanceAction(account);
    if (action === "upgrade_to_max") {
      setMaxUpgradeError(undefined);
      setMaxUpgradePrompt({ action, plan: "max", transport: "hosted" });
      return;
    }
    runDepletedBalanceAction(account)
      .then((outcome) => {
        if (outcome !== "opened_browser") void refreshAccount();
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [account, refreshAccount, showBillingNotice]);
  const [onboardingDone, setOnboardingDone] = useState(() => {
    applyOnboardingReplayFlag();
    return isOnboardingComplete();
  });
  // The wizard handles sign-in, permissions, and hands-on practice. Funding
  // only blocks once the account snapshot positively reports no spendable
  // credits.
  const onboardingRequired = !accountLoading && !onboardingDone;
  // Funding no longer blocks the shell or its read-only data. Onboarding still
  // holds bootstrap, update checks, and eager permission probes because the
  // wizard owns the permission prompts while it is on screen.
  const appBlocked = accountLoading || signInRequired || onboardingRequired;
  // The referral delight nudge's trigger layer: counts the moments (5th note,
  // first agent completion, 25th dictation) and surfaces the card when the
  // caps and gates allow. T4 (positive feedback) records from the report flow
  // directly.
  // Gated on captureActive too: a growth card sliding in mid-meeting is the
  // one timing guaranteed to annoy. A moment that fires during a recording is
  // consumed without showing (the caps never queue).
  useReferralNudgeTriggers({
    notes: state.notes,
    enabled: account.signedIn && !account.localDev && onboardingDone && !captureActive,
    onShow: (moment) => {
      referralNudgeSourceRef.current = "trigger";
      setReferralNudgeMoment(moment);
    },
  });
  const publishAgentMenuBarState = useCallback(() => {
    void emitAgentMenuBarState(
      buildAgentMenuBarState({
        // Completed sessions are filed away in the app, so they must not stay
        // openable from the native menu bar's recent-session shortcuts
        // (JUN-203 review).
        sessions: agentMenuBarSessionsRef.current.filter(
          (session) => !completedSessionsRef.current[session.id],
        ),
        workingSessionIds: agentMenuBarWorkingSessionIdsRef.current,
        waitingSessionIds: agentMenuBarWaitingSessionIdsRef.current,
        lastStatus: agentMenuBarLastStatusRef.current,
        agentHudEnabled: agentHudEnabledRef.current,
        limit: AGENT_MENU_BAR_SESSION_LIMIT,
      }),
    );
  }, []);
  // Keep the menu bar in step with completion changes: marking a session
  // complete (or active again) must add/remove it from the native shortcuts,
  // not just the in-app lists.
  useEffect(() => {
    completedSessionsRef.current = completedSessions;
    publishAgentMenuBarState();
  }, [completedSessions, publishAgentMenuBarState]);
  const profileScopedAgentSessions = useCallback(
    (sessions: readonly HermesSessionInfo[], profiles = sessionProfilesRef.current) => {
      if (profiles === null) return [];
      const activeProfile = getActiveHermesProfileName().trim() || activeHermesProfileName;
      return filterAgentSessionsForProfile(sessions, profiles, activeProfile);
    },
    [activeHermesProfileName],
  );
  const refreshSessionProfiles = useCallback(async () => {
    const profiles = sessionProfileMap(await listSessionProfiles());
    sessionProfilesRef.current = profiles;
    return profiles;
  }, []);
  const commitAgentSessions = useCallback(
    (sessions: readonly HermesSessionInfo[], profiles = sessionProfilesRef.current) => {
      const scopedSessions = profileScopedAgentSessions(sessions, profiles);
      agentMenuBarSessionsRef.current = scopedSessions;
      setAgentSessions(scopedSessions);
      publishAgentMenuBarState();
    },
    [profileScopedAgentSessions, publishAgentMenuBarState],
  );
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
  const selectedNoteLiveTranscript = useMemo(
    () => liveTranscriptEvents.filter((event) => event.noteId === selectedNoteId),
    [liveTranscriptEvents, selectedNoteId],
  );
  const selectedNoteTranscriptCoverageKey = authoritativeTranscriptCoverageKey(
    selectedNote?.sourceTranscripts ?? [],
  );
  // The contextual Ask June panel next to the open note. Scoped to one note:
  // it only renders while a note is the active view, and closes whenever the
  // open note changes (below) so it never flies out onto a different or
  // brand-new note the user didn't open it on.
  const [noteChatOpen, setNoteChatOpen] = useState(false);
  const noteChatOpenRef = useRef(noteChatOpen);
  noteChatOpenRef.current = noteChatOpen;
  const [confirmDeleteNote, setConfirmDeleteNote] = useState(false);
  const [shareNoteOpen, setShareNoteOpen] = useState(false);
  const [noteShareUrl, setNoteShareUrl] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset note-scoped UI on selection change
  useEffect(() => {
    setNoteChatOpen(false);
    setConfirmDeleteNote(false);
    setShareNoteOpen(false);
  }, [selectedNoteId]);
  // The note's Ask June chat is owned here, not inside the panel, so its
  // session and working state survive the panel closing: a fired-off question
  // keeps running in the background and the toolbar's Ask June button shows a
  // working dot until the reply lands.
  const noteChat = useNoteChat(
    selectedNote ? { id: selectedNote.id, title: selectedNote.title } : null,
  );
  const noteChatSessionIdRef = useRef(noteChat.storedSessionId);
  noteChatSessionIdRef.current = noteChat.storedSessionId;
  async function handleExportNotePdf() {
    if (!selectedNote) return;
    await exportNoteAsPdf(selectedNote.title, {
      showNotes:
        selectedNote.activeTab === "transcription"
          ? async () => {
              const note = await updateNote({ noteId: selectedNote.id, activeTab: "notes" });
              dispatch({ type: "noteUpdated", note });
            }
          : undefined,
    });
  }
  async function handleDownloadNoteAudio() {
    if (!selectedNote) return;
    try {
      const result = await downloadNoteAudio(selectedNote.id);
      toast.success("Audio downloaded", {
        action: {
          label: "Show file",
          onClick: () => {
            void revealPath(result.path).catch((err: unknown) => {
              toast.error(messageFromError(err));
            });
          },
        },
      });
    } catch (err) {
      toast.error(messageFromError(err));
    }
  }
  const noteToolbarActions = selectedNote ? (
    <NoteHeaderActions
      noteId={selectedNote.id}
      noteTitle={selectedNote.title}
      askJuneOpen={noteChatOpen}
      askJuneWorking={noteChat.working}
      onAskJune={() => setNoteChatOpen((open) => !open)}
      onShare={
        noteReadyToShare(selectedNote.processingStatus) ? () => setShareNoteOpen(true) : undefined
      }
      onExportPdf={() => void handleExportNotePdf()}
      onDownloadAudio={
        noteHasDownloadableAudio(selectedNote) ? () => void handleDownloadNoteAudio() : undefined
      }
      onDelete={() => setConfirmDeleteNote(true)}
    />
  ) : null;
  const originFolder = originFolderId
    ? state.folders.find((folder) => folder.id === originFolderId)
    : undefined;
  const agentOriginFolder =
    agentOrigin?.kind === "project"
      ? state.folders.find((folder) => folder.id === agentOrigin.folderId)
      : undefined;
  // The active session's project. Legacy sessions may have multiple project
  // assignments, so an explicit project origin wins over assignment order;
  // sessions opened elsewhere fall back to their first assignment.
  const activeAgentSessionFolder = activeAgentSessionId
    ? selectSessionProjectContext(
        state.folders,
        sessionFolders[activeAgentSessionId],
        agentOrigin?.kind === "project" ? agentOrigin.folderId : undefined,
      )
    : undefined;
  const agentProjectContextFolder =
    activeAgentSessionFolder ??
    (!activeAgentSessionId && agentOrigin?.kind === "project" ? agentOriginFolder : undefined);
  const recoveriesByNote = useMemo(() => {
    const map = new Map<string, (typeof state.activeRecoveries)[number]>();
    for (const recovery of state.activeRecoveries) {
      // If multiple recoveries land on one note, the first one wins —
      // backend should only surface one per note in practice.
      if (!map.has(recovery.noteId)) map.set(recovery.noteId, recovery);
    }
    return map;
  }, [state.activeRecoveries]);
  const recoverableNoteIds = useMemo(() => new Set(recoveriesByNote.keys()), [recoveriesByNote]);
  const selectedRecovery = selectedNote ? recoveriesByNote.get(selectedNote.id) : undefined;
  const noteDetailScrollerActive = activeView === "meetings" && !!selectedNote;
  const detailScrollerActive = activeView === "folders" && !!state.selectedFolderId;
  // A settings drill-in (e.g. a skill detail) that pins its own frosted
  // breadcrumb bar at the top of the panel and scrolls its content beneath —
  // the same pinned-bar mechanic as opening a meeting note from a folder. When
  // set, the outer body stops scrolling so the pinned bar stays fixed.
  const [settingsDetailPinned, setSettingsDetailPinned] = useState(false);
  const settingsDetailScrollerActive = activeView === "settings" && settingsDetailPinned;

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
      agentSessionId: activeView === "agent" ? activeAgentSessionId : undefined,
      agentSessionTitle:
        activeView === "agent" ? agentSessionTabTitle(activeAgentSessionSeed) : undefined,
      agentOrigin: activeView === "agent" ? agentOrigin : undefined,
    }),
    [
      activeView,
      selectedNoteId,
      originFolderId,
      originAllNotes,
      state.selectedFolderId,
      activeAgentSessionId,
      activeAgentSessionSeed?.preview,
      activeAgentSessionSeed?.title,
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
      prev.map((tab) => {
        if (tab.id !== activeTabId) return tab;
        const nav = refreshedTabNav(tab.nav, liveNav);
        return nav ? { ...tab, nav } : tab;
      }),
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
      setOriginFolderId(nav.view === "meetings" ? nav.originFolderId : undefined);
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
          ? (agentSessions.find((s) => s.id === nav.agentSessionId) ?? {
              id: nav.agentSessionId,
              title: nav.agentSessionTitle,
            })
          : undefined;
        setActiveAgentSessionId(nav.agentSessionId);
        setActiveAgentSessionSeed(session);
      } else {
        setActiveAgentSession(undefined);
      }
      const needsNoteLoad =
        nav.view === "meetings" && !!nav.noteId && selectedNoteIdRef.current !== nav.noteId;
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
      window.dispatchEvent(new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT));
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

  // Drag-reorder from the tab strip: the visible tabs land in their new order,
  // overflow tabs stay put (see reorderTabs).
  function handleReorderTabs(orderedVisibleIds: string[]) {
    setTabs((prev) => reorderTabs(prev, orderedVisibleIds));
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
          !(tab.nav.view === "meetings" && tab.nav.noteId && removedIds.has(tab.nav.noteId)),
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

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen<NoteDto>(NOTE_CALENDAR_CONTEXT_UPDATED_EVENT, (event) => {
      const noteProfile = calendarContextNoteProfilesRef.current.get(event.payload.id);
      calendarContextNoteProfilesRef.current.delete(event.payload.id);
      if (noteProfile !== getActiveHermesProfileName()) return;
      if (pendingCalendarContextAdoptionsRef.current.delete(event.payload.id)) {
        calendarContextNoteUpdatesRef.current.set(event.payload.id, event.payload);
      }
      dispatch({ type: "noteUpdated", note: event.payload });
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

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
  // so any nav surface (sidebar, notes list, command prompt) can open in a new
  // tab via ⌘/Ctrl-click or middle-click without threading flags through props.
  const newTabIntentRef = useRef(false);
  useEffect(() => {
    const record = (event: MouseEvent) => {
      newTabIntentRef.current = event.metaKey || event.ctrlKey || event.button === 1;
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

  // The label of the active settings section, so a tab parked on the Settings
  // view reads e.g. "MCP servers" instead of the generic "Settings". Only the
  // active tab is on the live settings view, so the section label applies to it.
  const settingsSectionLabel = useMemo(
    () => SETTINGS_TABS.find((tab) => tab.id === settingsTab)?.label,
    [settingsTab],
  );

  const tabItems = useMemo<TabItem[]>(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        ...tabMeta(
          tab.nav,
          state.notes,
          state.folders,
          agentSessions,
          tab.id === activeTabId ? settingsSectionLabel : undefined,
        ),
      })),
    [tabs, state.notes, state.folders, agentSessions, activeTabId, settingsSectionLabel],
  );

  function handleRecovery(sessionId: string, action: "validate" | "discard") {
    if (action === "validate" && fundingRequired) {
      setError(RECOVERY_FUNDING_DISABLED_REASON);
      return;
    }
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
      await osAccountsLogout({ clearBrowserSession: true });
      handleAccountChanged({ signedIn: false, configured: account.configured });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  useEffect(() => {
    preloadRecordingSounds();
    preloadAgentSounds();
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

  // Leaving the settings view drops any pinned settings drill-in, so the body
  // scroller is never left frozen for a view that has no pinned bar.
  useEffect(() => {
    if (activeView !== "settings") setSettingsDetailPinned(false);
  }, [activeView]);

  // Update state is read through refs so runUpdateCheck keeps a stable identity.
  // Otherwise the launch effect and the manual-check listener below would tear
  // down and re-fire every time a download or relaunch toggles state.
  const preparingUpdateRef = useRef(false);
  const checkingUpdateRef = useRef(false);
  const readyUpdateRef = useRef<UpdatePromptPayload<JuneUpdate> | null>(null);
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
    (payload: UpdatePromptPayload<JuneUpdate>, mode: UpdateCheckMode) => {
      if (preparingUpdateRef.current || readyUpdateRef.current || relaunchingUpdateRef.current) {
        return;
      }

      preparingUpdateRef.current = true;
      updateProgressHiddenRef.current = false;
      setPreparingUpdate(true);
      setReadyUpdate(null);
      setUpdateProgress(null);
      setUpdateStatus(mode === "manual" ? "Downloading update..." : null);

      void prepareJuneUpdate({
        update: payload.update,
        reportProgress: (progress) => {
          setUpdateProgress(progress);
          if (mode === "manual" && !updateProgressHiddenRef.current) {
            setUpdateStatus(
              progress.state === "installing" ? "Preparing update..." : "Downloading update...",
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
          setUpdateStatus(`Update failed: ${message}`, true);
        },
      });
    },
    [setUpdateStatus],
  );

  const runUpdateCheck = useCallback(
    // `check` defaults to the routine, forward-only check; the leave-rc reconcile
    // passes reconcileToStable so it can pull an older stable (see below).
    (mode: UpdateCheckMode, check: () => Promise<JuneUpdate | null> = checkJuneUpdate) => {
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
      const showsStatus = updateCheckShowsStatus(mode);
      if (showsStatus) {
        setCheckingUpdate(true);
        setUpdateStatus("Checking for updates...");
      } else if (mode === "launch") setUpdateStatus(null);
      void checkForJuneUpdate(
        {
          check,
          prompt: (payload) => {
            prepareUpdate(payload, mode);
          },
          reportNoUpdate: () => setUpdateStatus(UP_TO_DATE_STATUS),
          reportFailure: (message) => {
            if (mode !== "periodic") {
              setUpdateStatus(`Update check failed: ${message}`, true);
            }
          },
        },
        mode,
      ).finally(() => {
        checkingUpdateRef.current = false;
        if (showsStatus) setCheckingUpdate(false);
      });
    },
    [prepareUpdate, setUpdateStatus],
  );

  // Auto-dismiss ONLY the up-to-date confirmation: linger, play the soft exit,
  // then clear. Any status change (a new check, a failure, a manual dismiss)
  // or unmount runs the cleanup and cancels the pending hide. Other statuses
  // never match, so this effect does not control their lifecycle.
  useEffect(() => {
    if (updateStatus !== UP_TO_DATE_STATUS) return;
    const leaveTimer = window.setTimeout(() => {
      dispatchUpdateStatusDisplay({ type: "beginUpToDateExit" });
    }, UP_TO_DATE_DISMISS_MS);
    const clearTimer = window.setTimeout(() => {
      dispatchUpdateStatusDisplay({ type: "clearUpToDate" });
    }, UP_TO_DATE_DISMISS_MS + UP_TO_DATE_EXIT_MS);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(clearTimer);
    };
  }, [updateStatus]);

  // Confirmed in Settings after switching off the rc channel: re-check with
  // reconcile=true (which re-stashes the Rust-side pending update, so a periodic
  // check between the Settings confirm and this call can't leave a stale handle)
  // then run the same download -> ready -> relaunch flow as any update.
  const handleReconcileToStable = useCallback(() => {
    runUpdateCheck("manual", reconcileToStable);
  }, [runUpdateCheck]);

  const handleRelaunchUpdate = useCallback(() => {
    if (!readyUpdateRef.current || relaunchingUpdateRef.current) return;
    relaunchingUpdateRef.current = true;
    setRelaunchingUpdate(true);
    setUpdateStatus(null);
    void relaunchJune().catch((error) => {
      relaunchingUpdateRef.current = false;
      setRelaunchingUpdate(false);
      setUpdateStatus(`Relaunch failed: ${messageFromError(error)}`, true);
    });
  }, [setUpdateStatus]);

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
    return startPeriodicJuneUpdateChecks(runUpdateCheck);
  }, [appBlocked, runUpdateCheck]);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen(CHECK_FOR_UPDATES_EVENT, () => runUpdateCheck("manual")).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
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

  useAppExternalEvents({
    agentMenuBarSessionsRef,
    setActiveAgentSession,
    setActiveView,
    setAgentOrigin,
  });

  useAgentAttentionNotifications({
    activeAgentSessionIdRef,
    activeViewRef,
    agentHudEnabledRef,
    dictationWorkflowActiveRef,
    noteChatOpenRef,
    noteChatSessionIdRef,
    recordingStatusRef,
  });

  useEffect(() => {
    publishAgentMenuBarState();
  }, [publishAgentMenuBarState]);

  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    let cancelled = false;
    let retryTimeout: number | undefined;

    function loadAgentMenuBarSessions(attempt: number) {
      Promise.all([
        listHermesSessions({ limit: AGENT_MENU_BAR_SESSION_FETCH_LIMIT }),
        refreshSessionProfiles(),
      ])
        .then(([sessions, profiles]) => {
          if (cancelled) return;
          commitAgentSessions(sessions, profiles);
        })
        .catch(() => {
          if (cancelled) return;
          const retryDelay = AGENT_MENU_BAR_SESSION_RETRY_DELAYS_MS[attempt];
          if (retryDelay == null) return;
          retryTimeout = window.setTimeout(() => loadAgentMenuBarSessions(attempt + 1), retryDelay);
        });
    }

    loadAgentMenuBarSessions(0);

    return () => {
      cancelled = true;
      if (retryTimeout != null) {
        window.clearTimeout(retryTimeout);
      }
    };
  }, [appBlocked, bootstrapped, commitAgentSessions, refreshSessionProfiles]);

  // Routine runs finish on the launchd-managed gateway with no webview
  // involvement, so nothing event-driven announces them. Poll the session
  // store (the same feed the Routines view reads) and post one native,
  // click-through notification per newly finished run. State persists so
  // reloads and restarts never renotify, and the first poll of an install
  // baselines silently instead of backfilling history.
  useAgentMenuSessions({
    appBlocked,
    bootstrapped,
  });

  // Project assignments for agent sessions, loaded once storage is up.
  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    let cancelled = false;
    void listSessionFolders()
      .then((assignments) => {
        if (cancelled) return;
        const next: Record<string, string[]> = {};
        for (const assignment of assignments) {
          next[assignment.sessionId] ??= [];
          next[assignment.sessionId].push(assignment.folderId);
        }
        setSessionFolders(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      });
    void listCompletedSessions()
      .then((rows) => {
        if (cancelled) return;
        // The session list can be interactive before this settles on a cold
        // launch. Merge rather than replace: this snapshot predates any toggle
        // the user already made, so locally toggled ids keep their local value
        // (applying the snapshot over them would show a completed session as
        // active while the database has it completed, until restart). Every
        // other row still applies, so the rest of the persisted completed
        // sessions are not lost (JUN-203 review).
        setCompletedSessions((prev) => {
          const next: Record<string, string> = {};
          for (const row of rows) next[row.sessionId] = row.completedAt;
          for (const touchedId of sessionCompletionTouchedRef.current) {
            const local = prev[touchedId];
            if (local === undefined) delete next[touchedId];
            else next[touchedId] = local;
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        // Surface it like the sibling loads: a silent failure would present
        // previously completed sessions as active with no indication their
        // persisted state was unavailable (JUN-203 review).
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [appBlocked, bootstrapped]);

  // A fresh install whose automatic launch-at-login enable failed during
  // onboarding completion gets another chance on every normal startup:
  // completion hides the wizard, so without this the retry would wait for
  // an onboarding version bump. No-ops once the default has been settled
  // (applied, or overridden by an explicit Settings toggle).
  useEffect(() => {
    if (appBlocked) return;
    void retryPendingAutostartDefault();
  }, [appBlocked]);

  useEffect(() => {
    let cancelled = false;

    function handleSessionsChanged(event: Event) {
      const detail = (event as CustomEvent<AgentSessionsChangedDetail>).detail;
      if (!detail) return;
      void refreshSessionProfiles()
        .then((profiles) => {
          if (cancelled) return;
          commitAgentSessions(detail.sessions, profiles);
        })
        .catch(() => {
          if (cancelled) return;
          commitAgentSessions(detail.sessions);
        });
      if (activeViewRef.current === "agent") {
        const selectedSessionId = detail.selectedSessionId;
        if (selectedSessionId) {
          setActiveAgentSessionId(selectedSessionId);
          setActiveAgentSessionSeed((current) =>
            current?.id === selectedSessionId ? current : undefined,
          );
        } else {
          setActiveAgentSession(undefined);
        }
      }
      // "New session" started from a project: file the first brand-new
      // session that gets selected; switching to a known session instead
      // abandons the intent.
      const pendingProject = pendingSessionProjectRef.current;
      if (pendingProject && detail.selectedSessionId) {
        pendingSessionProjectRef.current = null;
        const sessionId = detail.selectedSessionId;
        if (pendingProject.profile !== getActiveHermesProfileName()) {
          setAgentOrigin(undefined);
        } else if (!pendingProject.knownSessionIds.has(sessionId)) {
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
        setAgentWorkingSessionIds(new Set(agentMenuBarWorkingSessionIdsRef.current));
        setAgentWaitingSessionIds(new Set(agentMenuBarWaitingSessionIdsRef.current));
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
      setAgentSessions((current) => current.filter((session) => session.id !== sessionId));
      agentMenuBarWorkingSessionIdsRef.current.delete(sessionId);
      agentMenuBarWaitingSessionIdsRef.current.delete(sessionId);
      setAgentWorkingSessionIds(new Set(agentMenuBarWorkingSessionIdsRef.current));
      setAgentWaitingSessionIds(new Set(agentMenuBarWaitingSessionIdsRef.current));
      publishAgentMenuBarState();
    }

    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, handleSessionsChanged);
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleAgentStatusForMenuBar);
    window.addEventListener(AGENT_DELETE_SESSION_EVENT, handleAgentSessionDeleted);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, handleSessionsChanged);
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleAgentStatusForMenuBar);
      window.removeEventListener(AGENT_DELETE_SESSION_EVENT, handleAgentSessionDeleted);
    };
  }, [commitAgentSessions, publishAgentMenuBarState, refreshSessionProfiles]);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;

    function handleVisibilityChanged(event: Event) {
      const detail = (event as CustomEvent<AgentHudVisibilityChangedDetail>).detail;
      if (detail) applyAgentHudVisibility(detail.enabled);
    }

    window.addEventListener(AGENT_HUD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    void listen<AgentHudVisibilityChangedDetail>(AGENT_HUD_VISIBILITY_CHANGED_EVENT, (event) =>
      applyAgentHudVisibility(event.payload.enabled),
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
      window.removeEventListener(AGENT_HUD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    };
  }, [applyAgentHudVisibility]);

  useEffect(() => {
    let aborted = false;
    const unlisteners: Array<() => void> = [];

    async function installMenuBarListener<T>(eventName: string, handler: (payload: T) => void) {
      try {
        const cleanup = await listen<T>(eventName, (event) => handler(event.payload));
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
        window.dispatchEvent(new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT));
      }, 0);
    });

    void installMenuBarListener<string>(AGENT_MENU_BAR_OPEN_SESSION_EVENT, (sessionId) => {
      setAgentOrigin(undefined);
      if (!sessionId) {
        setActiveAgentSession(undefined);
        setActiveView("agent");
        return;
      }
      setActiveAgentSessionId(sessionId);
      setActiveAgentSessionSeed(undefined);
      const cachedSession = agentMenuBarSessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (cachedSession) {
        setActiveAgentSession(cachedSession);
        setActiveView("agent");
        return;
      }
      void Promise.all([listHermesSessions({ limit: 100 }), refreshSessionProfiles()])
        .then(([sessions, profiles]) => {
          const scopedSessions = profileScopedAgentSessions(sessions, profiles);
          agentMenuBarSessionsRef.current = scopedSessions;
          const session = scopedSessions.find((item) => item.id === sessionId);
          if (session) setActiveAgentSession(session);
          setActiveView("agent");
          publishAgentMenuBarState();
        })
        .catch(() => {
          setActiveView("agent");
        });
    });

    void installMenuBarListener<boolean>(
      AGENT_MENU_BAR_SET_AGENT_HUD_EVENT,
      handleAgentHudVisibilityRequest,
    );

    return () => {
      aborted = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [
    handleAgentHudVisibilityRequest,
    profileScopedAgentSessions,
    publishAgentMenuBarState,
    refreshSessionProfiles,
  ]);

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
      dictationWorkflowActiveRef.current = nextDictationWorkflowActive(
        dictationWorkflowActiveRef.current,
        helperEvent.type,
      );
      if (helperEvent.type === "final_transcript") {
        // T3 of the referral delight nudge: a dictation landed (often while
        // June is backgrounded; the card waits to be found).
        recordDictationFinished();
        return;
      }
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
      const accessibility = stringPayloadValue(helperEvent.payload?.accessibility);
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
    void listen<{ action: "reopen"; noteId?: string }>("meeting-hud-action", (event) => {
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
    }).then((cleanup) => {
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
  useEffect(() => {
    if (!accessibilityBlocked) setAccessibilityBannerDismissed(false);
  }, [accessibilityBlocked]);

  // recordNoticesMicOverride is the dev __recordNoticesDemo hook parking the
  // mic-blocked notice; it is always null in production (the state never leaves
  // its initial value), so real behavior is untouched.
  const microphoneBlocked =
    recordNoticesMicOverride ?? isMicrophoneRecordingBlocked(microphoneStatus, sourceReadiness);

  const refreshPermissionStatuses = useCallback(() => {
    void dictationHelperCommand({ type: "get_permission_status" }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (appBlocked) return;
    bootstrapApp()
      .then(async (payload) => {
        const seeded = withFakeRecovery(payload);
        dispatch({ type: "bootstrapLoaded", payload: seeded.payload });
        const activeRecording = seeded.payload.activeRecording;
        const activeRecordingNoteId = activeRecording?.noteId;
        if (activeRecording) {
          recordingStatusRef.current = activeRecording;
          dispatch({ type: "recordingStatusChanged", status: activeRecording });
          if (activeRecordingNoteId) {
            calendarContextNoteProfilesRef.current.set(
              activeRecordingNoteId,
              getActiveHermesProfileName(),
            );
            pendingCalendarContextAdoptionsRef.current.add(activeRecordingNoteId);
            setRecordingNote(activeRecordingNoteId);
          }
        }
        if (seeded.fakeNote) {
          dispatch({ type: "noteLoaded", note: seeded.fakeNote });
          // The fake-recovery dev flow inspects the notes list, so it skips
          // the agent landing.
          setActiveView("notes");
          setBootstrapped(true);
          return;
        }
        // The app lands on the agent view, but a note is still selected up
        // front. After a webview reload, a live native capture takes priority
        // so its recorder controls and note association are restored.
        if (seeded.payload.notes.length === 0 && !activeRecordingNoteId) {
          const note = await createNote(undefined);
          dispatch({ type: "noteLoaded", note });
          setBootstrapped(true);
          return;
        }
        const firstNoteId = activeRecordingNoteId ?? seeded.payload.notes[0]?.id;
        if (firstNoteId) {
          const note = await getNote(firstNoteId);
          const calendarUpdate = calendarContextNoteUpdatesRef.current.get(firstNoteId);
          calendarContextNoteUpdatesRef.current.delete(firstNoteId);
          pendingCalendarContextAdoptionsRef.current.delete(firstNoteId);
          dispatch({ type: "noteLoaded", note: calendarUpdate ?? note });
        }
        setBootstrapped(true);
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [appBlocked]);

  useEffect(() => {
    function handleProfileDataChanged(event: Event) {
      const detail = (event as CustomEvent<ProfileDataChangedDetail>).detail;
      if (!detail || detail.profile !== getActiveHermesProfileName()) return;
      setProfileDataRefreshRevision((revision) => revision + 1);
    }

    window.addEventListener(PROFILE_DATA_CHANGED_EVENT, handleProfileDataChanged);
    return () => {
      window.removeEventListener(PROFILE_DATA_CHANGED_EVENT, handleProfileDataChanged);
    };
  }, []);

  // A profile switch swaps the visible data, not just the agent runtime
  // (ADR 0031): re-read profile-scoped notes, projects, chat mappings, and
  // sessions together. The same refresh runs when profile data moves into the
  // already-active profile, where the active profile name itself does not
  // change. If a recording is running its note keeps the selection (get_note
  // is unscoped) so the recording view is never yanked mid-take.
  const lastDataProfileRef = useRef<string | undefined>(undefined);
  const lastProfileDataRefreshRevisionRef = useRef(0);
  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    const previous = lastDataProfileRef.current;
    const profileChanged = previous !== undefined && previous !== activeHermesProfileName;
    const refreshRequested =
      lastProfileDataRefreshRevisionRef.current !== profileDataRefreshRevision;
    lastDataProfileRef.current = activeHermesProfileName;
    lastProfileDataRefreshRevisionRef.current = profileDataRefreshRevision;
    if (!refreshRequested && (previous === undefined || previous === activeHermesProfileName)) {
      return;
    }
    // A project-scoped new-session request belongs to the profile that started
    // it. Clear the handoff before any async reload can race a session-created
    // event from the newly active profile.
    if (profileChanged) pendingSessionProjectRef.current = null;
    let cancelled = false;
    void (async () => {
      try {
        const [notesResponse, folders, sessions, profiles] = await Promise.all([
          listNotes(),
          listFolders(),
          listHermesSessions({ limit: 100 }),
          refreshSessionProfiles(),
        ]);
        if (cancelled) return;
        commitAgentSessions(sessions, profiles);
        const visibleNoteIds = new Set(notesResponse.items.map((note) => note.id));
        const recordingNoteId = recordingNoteIdRef.current;
        crossProfileRecordingNoteIdRef.current =
          recordingNoteId && !visibleNoteIds.has(recordingNoteId) ? recordingNoteId : undefined;
        const invalidNoteIds = new Set<string>();
        for (const tab of tabsRef.current) {
          const noteId = tab.nav.view === "meetings" ? tab.nav.noteId : undefined;
          if (noteId && noteId !== recordingNoteId && !visibleNoteIds.has(noteId)) {
            invalidNoteIds.add(noteId);
          }
        }
        const nextTabs = invalidateNoteTabs(tabsRef.current, invalidNoteIds);
        if (nextTabs !== tabsRef.current) {
          tabsRef.current = nextTabs;
          setTabs(nextTabs);
        }
        // The old profile's folder selection and origins point at rows the
        // new profile can't see — clear them before the new lists land.
        dispatch({ type: "folderSelected", folderId: undefined });
        dispatch({ type: "foldersLoaded", folders });
        dispatch({ type: "notesLoaded", notes: notesResponse.items });
        setOriginFolderId(undefined);
        setOriginAllNotes(false);
        setFolderReturnTarget(undefined);
        // The open chat came from the old profile's list; keeping it selected
        // would reopen it (workspace re-applies initialSessionId on mount).
        setActiveAgentSession(undefined);
        setAgentOrigin(undefined);
        const nextNoteId = recordingNoteIdRef.current ?? notesResponse.items[0]?.id;
        if (nextNoteId) {
          const note = await getNote(nextNoteId);
          if (!cancelled) dispatch({ type: "noteLoaded", note });
        } else if (!cancelled) {
          const currentView = activeViewRef.current;
          if (currentView === "meetings" || currentView === "all-notes") {
            setActiveView("notes");
          }
        }
      } catch (err) {
        if (!cancelled) setError(messageFromError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeHermesProfileName,
    appBlocked,
    bootstrapped,
    commitAgentSessions,
    profileDataRefreshRevision,
    refreshSessionProfiles,
    setActiveAgentSession,
  ]);

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
    refreshPermissionStatuses();
    return () => {
      cancelled = true;
    };
  }, [appBlocked, refreshPermissionStatuses]);

  // Refresh permission state whenever the app regains focus — covers the
  // common case where the user flipped a toggle in System Settings and
  // returns to June. The helper poll is what surfaces fresh mic /
  // accessibility state via the dictation-event listener above.
  useEffect(() => {
    if (appBlocked) return;
    function refresh() {
      refreshPermissionStatuses();
      if (captureActive) return;
      void checkRecordingSourceReadiness("microphonePlusSystem")
        .then(setSourceReadiness)
        .catch(() => undefined);
    }
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [appBlocked, captureActive, refreshPermissionStatuses]);

  // While Accessibility is missing, keep checking. macOS can leave stale
  // "June" rows from older builds in System Settings; after the current helper
  // is toggled, this notices the live TCC change without requiring a restart.
  useEffect(() => {
    if (appBlocked || !accessibilityBlocked) return;
    refreshPermissionStatuses();
    const interval = window.setInterval(
      refreshPermissionStatuses,
      ACCESSIBILITY_PERMISSION_REFRESH_INTERVAL_MS,
    );
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refreshPermissionStatuses();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [accessibilityBlocked, appBlocked, refreshPermissionStatuses]);

  // After the user opens System Settings for System Audio Recording, keep
  // checking briefly while macOS is in front. This matches Accessibility's
  // permission flow and avoids relying on a single webview focus event.
  useEffect(() => {
    if (appBlocked || captureActive || systemGranted || systemAudioRefreshRequest === 0) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    function poll() {
      if (inFlight) return;
      inFlight = true;
      void checkRecordingSourceReadiness("microphonePlusSystem")
        .then((readiness) => {
          if (!cancelled) setSourceReadiness(readiness);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }
    poll();
    const interval = window.setInterval(poll, SYSTEM_AUDIO_PERMISSION_REFRESH_INTERVAL_MS);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
    }, SYSTEM_AUDIO_PERMISSION_REFRESH_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [appBlocked, captureActive, systemAudioRefreshRequest, systemGranted]);

  function handleSourceModeChange(next: RecordingSourceMode) {
    setUserWantsSystemAudio(next === "microphonePlusSystem");
  }

  // Explicit "Enable" action when system audio is denied. Sets intent on
  // (so the toggle auto-flips ON once permission is granted) and routes
  // the user to the System Settings pane.
  function handleEnableSystemAudio() {
    setUserWantsSystemAudio(true);
    setSystemAudioRefreshRequest((request) => request + 1);
    void openPrivacySettings("systemAudio");
  }

  function handleEnableMicrophone() {
    void openPrivacySettings("microphone");
  }

  function handleEnableAccessibility() {
    void dictationHelperCommand({
      type: "request_accessibility_permission",
    }).catch(async () => {
      try {
        await openPrivacySettings("accessibility");
      } catch {
        // The fallback is best-effort; there is no further recovery surface.
      }
    });
  }

  useEffect(() => {
    if (!state.recordingStatus || !["recording", "paused"].includes(state.recordingStatus.state)) {
      return;
    }
    const sessionId = state.recordingStatus.sessionId;
    // The dev __recordNoticesDemo session lives only in the reducer — there is
    // no backend recording to poll, and getRecordingStatus would clear the
    // synthetic bar with a "recording not found". Stripped from production via
    // import.meta.env.DEV. See lib/record-notices-demo.ts.
    if (import.meta.env.DEV && sessionId === RECORD_NOTICES_DEMO_SESSION_ID) {
      return;
    }
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
    if (
      !selectedNote ||
      (selectedNote.processingStatus !== "ready" && selectedNote.processingStatus !== "failed") ||
      (selectedNote.queuedRecordings ?? 0) > 0
    ) {
      return;
    }
    const protectedSessionIds = [...finishingSessionsRef.current];
    if (recordingNoteId === selectedNote.id && state.recordingStatus?.sessionId) {
      protectedSessionIds.push(state.recordingStatus.sessionId);
    }
    setLiveTranscriptEvents((current) =>
      clearTerminalLiveTranscriptEvents(
        current,
        selectedNote.id,
        selectedNote.sourceTranscripts ?? [],
        protectedSessionIds,
      ),
    );
  }, [
    recordingNoteId,
    selectedNote?.id,
    selectedNote?.processingStatus,
    selectedNote?.queuedRecordings,
    selectedNoteTranscriptCoverageKey,
    state.recordingStatus?.sessionId,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let aborted = false;
    void listen<LiveTranscriptEventDto>(LIVE_TRANSCRIPT_EVENT, (event) => {
      const payload = event.payload;
      const activeRecording = recordingStatusRef.current;
      if (!activeRecording || payload.sessionId !== activeRecording.sessionId) {
        return;
      }
      if (recordingNoteIdRef.current && payload.noteId !== recordingNoteIdRef.current) {
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
    if (!selectedNote || !shouldPollProcessingStatus(selectedNote.processingStatus)) {
      return;
    }
    // The dev __processingDemo note lives only in the reducer; there is no
    // backend row to poll, and getNote would clobber its synthetic stage with
    // a "note not found". Stripped from production via import.meta.env.DEV.
    if (import.meta.env.DEV && selectedNote.id === PROCESSING_DEMO_NOTE_ID) {
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
        const targetFolderId = folderId === null ? undefined : (folderId ?? state.selectedFolderId);
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
      window.dispatchEvent(new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT));
    }, 0);
  }, []);

  /** stored session id (not the runtime session id). */
  const handleRenameAgentSession = useCallback(
    (sessionId: string, title: string) => {
      const next = title.trim();
      const currentSession = agentSessions.find((session) => session.id === sessionId);
      const currentTitle =
        currentSession?.title?.trim() ||
        currentSession?.preview?.trim() ||
        (currentSession ? "Untitled session" : "");
      if (!next || next === currentTitle) return;

      const renameSession = (session: HermesSessionInfo) =>
        session.id === sessionId ? { ...session, title: next } : session;
      setAgentSessions((current) => current.map(renameSession));
      agentMenuBarSessionsRef.current = agentMenuBarSessionsRef.current.map(renameSession);
      publishAgentMenuBarState();
      void ensureHermesBridgeSession({ sessionId, title: next }).catch(() => {
        setError("Could not save the session name. It may revert after a restart.");
      });
      rememberSessionManuallyTitled(sessionId);
      recordManualAgentSessionTitle(sessionId, next);
      window.dispatchEvent(
        new CustomEvent<AgentSessionRenamedDetail>(AGENT_SESSION_RENAMED_EVENT, {
          detail: { sessionId, title: next },
        }),
      );
      // The Agent HUD is a separate window listening on the cross-window
      // sessions channel; without this emit it would show the old title until
      // an unrelated sessions-changed broadcast.
      emitAgentSessionsChanged({
        sessions: agentMenuBarSessionsRef.current,
        workingSessionIds: [...agentMenuBarWorkingSessionIdsRef.current],
        waitingSessionIds: [...agentMenuBarWaitingSessionIdsRef.current],
      });
    },
    [agentSessions, publishAgentMenuBarState],
  );

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
  }, [activeView, appBlocked, bootstrapped, handleCreateNote, selectedNote, state.selectedNoteId]);

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

  function handleFoldersImported(folders: FolderDto[]) {
    for (const folder of folders) {
      dispatch({ type: "folderCreated", folder });
    }
    toast.success(`${folders.length} ${folders.length === 1 ? "project" : "projects"} added`);
  }

  async function handleRenameFolder(folderId: string, name: string, description?: string) {
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

  async function handleRemoveNoteFromFolder(
    noteId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    try {
      const note = await removeNoteFromFolder(noteId, folderId);
      dispatch({ type: "noteUpdated", note });
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
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

  async function handleToggleSessionCompleted(sessionId: string, completed: boolean) {
    // A local toggle outranks the initial load's pre-toggle snapshot for this id.
    sessionCompletionTouchedRef.current.add(sessionId);
    // The exact prior value for this one session, so a failed write can be rolled
    // back precisely (restoring the original completed_at on a failed unmark)
    // without touching any other session's optimistic state.
    const priorValue = completedSessions[sessionId];
    setCompletedSessions((prev) => {
      const next = { ...prev };
      if (completed) next[sessionId] = new Date().toISOString();
      else delete next[sessionId];
      return next;
    });
    // Serialize writes per session. Toggling complete -> active faster than the
    // first write resolves would otherwise let two commands reach the SQLite
    // pool concurrently and land out of order (the DELETE before the INSERT),
    // leaving the row completed while the UI shows active. Chaining keeps the
    // persisted state matching the last user action (JUN-203 review).
    const pending = sessionCompletionWritesRef.current;
    const write = (pending.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => setSessionCompleted(sessionId, completed));
    const chained = write.catch(() => {});
    pending.set(sessionId, chained);
    try {
      await write;
    } catch (err: unknown) {
      // Roll back only this session to its captured prior value, and only if no
      // newer toggle for it has queued behind us (that newer write now owns the
      // session). Reverting just this id leaves every other session's optimistic
      // and in-flight state intact, and surfacing the error keeps a failed
      // context-menu action from looking like it silently did nothing.
      if (pending.get(sessionId) === chained) {
        // Un-track only when the rollback leaves the session with no local
        // completion: then a still-in-flight boot snapshot restoring its true
        // state is exactly what we want. If the rollback restores an earlier
        // successful completion, keep it tracked — a pre-toggle snapshot that
        // predates that completion would otherwise wipe the row from the UI
        // while SQLite still has it completed.
        if (priorValue === undefined) sessionCompletionTouchedRef.current.delete(sessionId);
        setCompletedSessions((prev) => {
          const next = { ...prev };
          if (priorValue === undefined) delete next[sessionId];
          else next[sessionId] = priorValue;
          return next;
        });
      }
      setError(messageFromError(err));
    } finally {
      // Drop the chain only when no newer toggle queued behind this one.
      if (pending.get(sessionId) === chained) pending.delete(sessionId);
    }
  }

  async function handleRemoveSessionFromFolder(
    sessionId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    try {
      await removeSessionFromFolder(sessionId, folderId);
      setSessionFolders((prev) => {
        const next = { ...prev };
        const remaining = (next[sessionId] ?? []).filter((id) => id !== folderId);
        if (remaining.length > 0) next[sessionId] = remaining;
        else delete next[sessionId];
        return next;
      });
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
    }
  }

  // "Report an issue": navigate to Agent and open the direct report dialog.
  // It submits through June API without a model turn, so there is nothing to
  // charge; June API creates the team-facing diagnosis.
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

  // Escalates a note chat into the full agent view: an existing session opens
  // in place (it's a normal Hermes session, so history already knows it); a
  // chat that never started falls back to the seeded new-session flow.
  function handleOpenNoteChatInAgent(noteRef: { id: string; title: string }, sessionId?: string) {
    if (!sessionId) {
      handleAskJuneAboutNote(noteRef);
      return;
    }
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    setActiveAgentSession({ id: sessionId, title: noteRef.title.trim() || undefined });
    setActiveView("agent");
  }

  function handleAskJuneAboutNote(noteRef: { id: string; title: string }) {
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    markAgentNewSessionPending(undefined, { noteRef });
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT, {
          detail: { noteRef },
        }),
      );
    }, 0);
  }

  // "Start chat with this bundle" from the Bundles settings tab: the same
  // fresh-chat handshake the dictation prompt path uses, auto-submitting the
  // bundle's slash command so Hermes resolves the bundle and loads its skills.
  function handleStartBundleChat(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    markAgentNewSessionPending(trimmed);
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT, {
          detail: { prompt: trimmed },
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
      profile: getActiveHermesProfileName(),
    };
    setAgentOrigin({ kind: "project", folderId });
    markAgentNewSessionPending();
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT));
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

  // Jumps from an open session to the project it's filed in (the crumb that
  // shows even when the session was opened from the Sessions view).
  function handleOpenSessionProject(folderId: string) {
    setActiveView("folders");
    dispatch({ type: "folderSelected", folderId });
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

  function handleEmptyNotesAfterDelete() {
    const currentView = activeViewRef.current;
    if (currentView === "meetings" || currentView === "notes" || currentView === "all-notes") {
      setActiveView("notes");
    }
    setOriginFolderId(undefined);
    setOriginAllNotes(false);
    setFolderReturnTarget(undefined);
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
        handleEmptyNotesAfterDelete();
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
        handleEmptyNotesAfterDelete();
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

  async function handleUpdateNote(patch: Partial<Pick<NoteDto, "title" | "editedContent">>) {
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
      options: { startAlreadyClaimed?: boolean; sourceMode?: RecordingSourceMode } = {},
    ): Promise<boolean> => {
      if (fundingRequired) {
        setError(RECORDING_FUNDING_DISABLED_REASON);
        return false;
      }
      const startAlreadyClaimed = options.startAlreadyClaimed ?? false;
      const requestedSourceMode = options.sourceMode ?? sourceMode;
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
      const recordingProfile = getActiveHermesProfileName();
      setRecordingNote(noteId);
      const startingStatus = startingRecordingStatus(noteId, requestedSourceMode);
      recordingStatusRef.current = startingStatus;
      dispatch({
        type: "recordingStatusChanged",
        status: startingStatus,
      });
      try {
        setCheckingSourceReadiness(true);
        const readiness = await checkRecordingSourceReadiness(requestedSourceMode);
        setSourceReadiness((previous) => mergeSourceReadiness(previous, readiness));

        const micSource = readiness.sources.find((source) => source.source === "microphone");
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
        const systemSource = readiness.sources.find((source) => source.source === "system");
        const effectiveMode: RecordingSourceMode =
          requestedSourceMode === "microphonePlusSystem" && !systemSource?.ready
            ? "microphoneOnly"
            : requestedSourceMode;

        calendarContextNoteProfilesRef.current.set(noteId, recordingProfile);
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
        calendarContextNoteProfilesRef.current.delete(noteId);
        // The ref was set optimistically above; a failed start must not leave
        // the meeting HUD's reopen path pointing at a note with no recording.
        setRecordingNote(undefined);
        recordingStatusRef.current = undefined;
        dispatch({ type: "recordingStatusCleared" });
        // A TCC denial resolved inside start_recording (the first-run prompt
        // declined, or the grant revoked after the readiness probe): re-probe
        // so the persistent mic-blocked notice appears with its Enable action,
        // not just this transient error (JUN-319).
        if (errorCode(err) === "microphone_permission_missing") {
          void checkRecordingSourceReadiness(requestedSourceMode)
            .then((readiness) =>
              setSourceReadiness((previous) => mergeSourceReadiness(previous, readiness)),
            )
            .catch(() => undefined);
        }
        setError(messageFromError(err));
        return false;
      } finally {
        recordingStartInFlightRef.current = false;
        setCheckingSourceReadiness(false);
      }
    },
    [fundingRequired, setRecordingNote, sourceMode],
  );

  const handleStartRecording = useCallback(async () => {
    if (!selectedNoteId) return;
    await handleStartRecordingForNote(selectedNoteId);
  }, [handleStartRecordingForNote, selectedNoteId]);

  const meetingStartReadyRef = useRef(false);
  const meetingStartListenerRegisteredRef = useRef(false);
  const drainPendingMeetingStartRef = useRef<() => void>(() => {});
  meetingStartReadyRef.current = !appBlocked && bootstrapped;

  const handleStartMeetingDetectedRecording = useCallback(
    async (requestId: string, noteId: string) => {
      if (fundingRequired) {
        revealMainWindowForMeetingStartError();
        setError(RECORDING_FUNDING_DISABLED_REASON);
        return true;
      }
      const competingRecording = recordingStatusRef.current;
      if (recordingStartInFlightRef.current || competingRecording?.state === "starting") {
        return false;
      }
      if (competingRecording) return true;
      calendarContextNoteProfilesRef.current.set(noteId, getActiveHermesProfileName());
      pendingCalendarContextAdoptionsRef.current.add(noteId);
      recordingStartInFlightRef.current = true;
      setCheckingSourceReadiness(true);
      try {
        const outcome = await startMeetingRecording(requestId, sourceMode);
        if (!meetingStartReadyRef.current || !meetingStartListenerRegisteredRef.current) {
          return false;
        }
        if (outcome.status === "failed") {
          calendarContextNoteProfilesRef.current.delete(noteId);
          pendingCalendarContextAdoptionsRef.current.delete(noteId);
          calendarContextNoteUpdatesRef.current.delete(noteId);
          revealMainWindowForMeetingStartError();
          if (outcome.error.code === "meeting_start_expired") {
            setError(MEETING_START_REQUEST_EXPIRED_MESSAGE);
          } else {
            setError(messageFromError(outcome.error));
          }
          if (outcome.error.code === "microphone_permission_missing") {
            void checkRecordingSourceReadiness(sourceMode)
              .then((readiness) =>
                setSourceReadiness((previous) => mergeSourceReadiness(previous, readiness)),
              )
              .catch(() => undefined);
          }
          // A reload can briefly bootstrap the deterministic draft while the
          // native start is still running. Refresh after a terminal failure so
          // native cleanup cannot leave that now-deleted draft visible.
          try {
            const previousNoteId = selectedNoteIdRef.current;
            const response = await listNotes();
            dispatch({ type: "notesLoaded", notes: response.items });
            const restoreNoteId = response.items.some((note) => note.id === previousNoteId)
              ? previousNoteId
              : response.items[0]?.id;
            if (restoreNoteId) {
              const restored = await getNote(restoreNoteId);
              dispatch({ type: "noteLoaded", note: restored });
            } else {
              const currentView = activeViewRef.current;
              if (
                currentView === "meetings" ||
                currentView === "notes" ||
                currentView === "all-notes"
              ) {
                setActiveView("notes");
              }
              setOriginFolderId(undefined);
              setOriginAllNotes(false);
              setFolderReturnTarget(undefined);
            }
          } catch {
            // The terminal error is already visible and native owns cleanup;
            // a later notes refresh will reconcile this best-effort view.
          }
          return true;
        }

        const { note, recording } = outcome;
        const calendarUpdate = calendarContextNoteUpdatesRef.current.get(note.id);
        calendarContextNoteUpdatesRef.current.delete(note.id);
        pendingCalendarContextAdoptionsRef.current.delete(note.id);
        dispatch({ type: "noteLoaded", note: calendarUpdate ?? note });
        setOriginFolderId(undefined);
        setOriginAllNotes(false);
        setActiveView("meetings");
        setRecordingNote(note.id);
        const status = recordingToStatus(recording);
        recordingStatusRef.current = status;
        dispatch({
          type: "recordingStatusChanged",
          status,
        });
        playRecordingSound("start");
        return true;
      } catch {
        return false;
      } finally {
        recordingStartInFlightRef.current = false;
        setCheckingSourceReadiness(false);
      }
    },
    [fundingRequired, setRecordingNote, sourceMode],
  );

  const handleStartAgentRecording = useCallback(
    async (requestedSourceMode: RecordingSourceMode) => {
      if (fundingRequired) {
        throw new Error(RECORDING_FUNDING_DISABLED_REASON);
      }
      if (recordingStartInFlightRef.current || recordingStatusRef.current) {
        throw new Error(
          `A recording is already running for note ${recordingNoteIdRef.current ?? "unknown"}.`,
        );
      }
      recordingStartInFlightRef.current = true;
      const previousNoteId = selectedNoteId;
      let handedStartClaimToRecorder = false;
      let createdNoteId: string | undefined;
      try {
        const note = await createNote(undefined);
        createdNoteId = note.id;
        dispatch({ type: "noteLoaded", note });
        setOriginFolderId(undefined);
        setOriginAllNotes(false);
        setActiveView("meetings");
        handedStartClaimToRecorder = true;
        const started = await handleStartRecordingForNote(note.id, {
          startAlreadyClaimed: true,
          sourceMode: requestedSourceMode,
        });
        if (started) return note;

        try {
          await deleteNote(note.id);
        } catch (deleteErr) {
          console.warn("Failed to delete note after recording start failed", deleteErr);
        }
        const response = await listNotes();
        dispatch({ type: "notesLoaded", notes: response.items });
        const restoreNoteId =
          previousNoteId && previousNoteId !== note.id ? previousNoteId : response.items[0]?.id;
        if (restoreNoteId) {
          const restored = await getNote(restoreNoteId);
          dispatch({ type: "noteLoaded", note: restored });
        } else {
          handleEmptyNotesAfterDelete();
        }
        throw new Error("Recording did not start.");
      } catch (err) {
        if (createdNoteId && !handedStartClaimToRecorder) {
          try {
            await deleteNote(createdNoteId);
          } catch (deleteErr) {
            console.warn("Failed to delete note after recording start failed", deleteErr);
          }
        }
        throw err;
      } finally {
        if (!handedStartClaimToRecorder) {
          recordingStartInFlightRef.current = false;
        }
      }
    },
    [fundingRequired, handleStartRecordingForNote, selectedNoteId],
  );

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

  // Native retains the request and its terminal result until this webview
  // explicitly acknowledges it. Reloads can therefore replay the same token
  // without creating a second note or restarting an active capture.
  const meetingStartHandlerRef = useRef<(requestId: string, noteId: string) => Promise<boolean>>(
    async () => false,
  );
  meetingStartHandlerRef.current = handleStartMeetingDetectedRecording;

  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    drainPendingMeetingStartRef.current();
  }, [appBlocked, bootstrapped]);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    let listenerRetryTimer: number | undefined;
    let drainRetryTimer: number | undefined;
    let drainRunning = false;
    let drainAgain = false;

    const scheduleDrainRetry = () => {
      if (aborted || drainRetryTimer !== undefined) return;
      drainRetryTimer = window.setTimeout(() => {
        drainRetryTimer = undefined;
        drainPendingRequest();
      }, 500);
    };

    function drainPendingRequest() {
      if (!meetingStartReadyRef.current || !meetingStartListenerRegisteredRef.current) return;
      if (drainRunning) {
        drainAgain = true;
        return;
      }
      drainRunning = true;
      void (async () => {
        let shouldRetry = false;
        try {
          const request = await pendingMeetingStartRequest();
          if (
            aborted ||
            !meetingStartReadyRef.current ||
            !meetingStartListenerRegisteredRef.current ||
            !request
          ) {
            return;
          }
          if (request.expired) {
            revealMainWindowForMeetingStartError();
            setError(MEETING_START_REQUEST_EXPIRED_MESSAGE);
            const acknowledged = await acknowledgeMeetingStartRequest(request.requestId);
            shouldRetry = !acknowledged;
            return;
          }
          const terminal = await meetingStartHandlerRef.current(request.requestId, request.noteId);
          if (
            aborted ||
            !meetingStartReadyRef.current ||
            !meetingStartListenerRegisteredRef.current
          ) {
            return;
          }
          if (!terminal) {
            shouldRetry = true;
            return;
          }
          const acknowledged = await acknowledgeMeetingStartRequest(request.requestId);
          shouldRetry = !acknowledged;
        } catch {
          shouldRetry = true;
        } finally {
          drainRunning = false;
          if (!aborted) {
            if (drainAgain) {
              drainAgain = false;
              drainPendingRequest();
            } else if (shouldRetry) {
              scheduleDrainRetry();
            }
          }
        }
      })();
    }
    drainPendingMeetingStartRef.current = drainPendingRequest;

    const register = (attempt = 0) => {
      void listen(MEETING_START_TRANSCRIPTION_EVENT, drainPendingRequest)
        .then((cleanup) => {
          if (aborted) {
            cleanup();
            return;
          }
          unlisten = cleanup;
          meetingStartListenerRegisteredRef.current = true;
          drainPendingRequest();
        })
        .catch((error) => {
          if (!aborted) {
            console.warn("Failed to register the meeting start listener; retrying.", error);
            const retryDelay =
              MEETING_START_LISTENER_RETRY_DELAYS_MS[
                Math.min(attempt, MEETING_START_LISTENER_RETRY_DELAYS_MS.length - 1)
              ];
            listenerRetryTimer = window.setTimeout(() => register(attempt + 1), retryDelay);
          }
        });
    };

    register();
    return () => {
      aborted = true;
      meetingStartListenerRegisteredRef.current = false;
      if (listenerRetryTimer !== undefined) window.clearTimeout(listenerRetryTimer);
      if (drainRetryTimer !== undefined) window.clearTimeout(drainRetryTimer);
      unlisten?.();
    };
  }, []);

  // The handler closes over frequently-changing state, but the Tauri listener
  // must register exactly once: re-subscribing tears the listener down and
  // events emitted in the gap are silently dropped (a dropped request costs
  // the agent a full proxy lease). The ref always holds the latest closure.
  const agentRecorderHandlerRef = useRef<(payload: AgentRecorderRequestPayload) => Promise<void>>(
    async () => {},
  );
  agentRecorderHandlerRef.current = async (payload: AgentRecorderRequestPayload) => {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;

    const resolve = (result: {
      ok: boolean;
      noteId?: string;
      noteTitle?: string;
      errorCode?: string;
      errorMessage?: string;
    }) => {
      void resolveAgentRecorderRequest({ requestId, ...result }).catch(async (err) => {
        console.warn("Failed to resolve agent recorder request", err);
        // A transient resolve failure (IPC hiccup, poisoned lock) happens
        // while the proxy is still waiting inside its lease: retry once
        // instead of treating it as an expired request.
        if (errorCode(err) !== "agent_recorder_request_not_found") {
          try {
            await resolveAgentRecorderRequest({ requestId, ...result });
            return;
          } catch (retryErr) {
            if (errorCode(retryErr) !== "agent_recorder_request_not_found") {
              console.warn("Agent recorder resolve retry failed", retryErr);
              return;
            }
          }
        }
        // Lease expired: the proxy already told the agent this request
        // failed. Leaving a recording running that the agent believes never
        // started diverges tool state from app state, so stop a successful
        // late start. The note (and any audio it captured) is kept: it is
        // real user data and the recorder was visibly running.
        if (result.ok && payload.action === "start") {
          const active = recordingStatusRef.current;
          if (active && recordingNoteIdRef.current === result.noteId) {
            try {
              await handleFinishRecording(active.sessionId, { rethrow: true });
            } catch (rollbackErr) {
              console.warn("Failed to stop expired agent recording", rollbackErr);
            }
          }
        }
      });
    };

    if (appBlocked || !bootstrapped) {
      resolve({
        ok: false,
        errorCode: "app_not_ready",
        errorMessage: "June is not ready to start or stop recording yet.",
      });
      return;
    }

    try {
      if (payload.action === "start") {
        const requestedSourceMode: RecordingSourceMode =
          payload.sourceMode === "microphonePlusSystem" ? "microphonePlusSystem" : "microphoneOnly";
        const note = await handleStartAgentRecording(requestedSourceMode);
        resolve({ ok: true, noteId: note.id, noteTitle: note.title });
        return;
      }
      if (payload.action === "stop") {
        const activeRecording = recordingStatusRef.current;
        const noteId = recordingNoteIdRef.current ?? activeRecording?.noteId;
        const noteTitle = noteId
          ? (state.notes.find((note) => note.id === noteId)?.title ?? selectedNote?.title)
          : undefined;
        if (!activeRecording) {
          resolve({
            ok: false,
            errorCode: "recording_not_found",
            errorMessage: "No recording is currently running.",
          });
          return;
        }
        await handleFinishRecording(activeRecording.sessionId, { rethrow: true });
        resolve({ ok: true, noteId, noteTitle });
        return;
      }
      resolve({
        ok: false,
        errorCode: "invalid_action",
        errorMessage: "Recorder action must be start or stop.",
      });
    } catch (err) {
      resolve({
        ok: false,
        errorCode: "agent_recorder_failed",
        errorMessage: messageFromError(err),
      });
    }
  };

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen(AGENT_RECORDER_REQUEST_EVENT, (event) => {
      void agentRecorderHandlerRef.current((event.payload ?? {}) as AgentRecorderRequestPayload);
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  async function handleFinishRecording(sessionId: string, options: { rethrow?: boolean } = {}) {
    // The dev __recordNoticesDemo session has no backend recording — stopping it
    // just tears the demo down (clears the synthetic status and pins) instead of
    // calling finishRecording, which would fail with "recording not found".
    if (import.meta.env.DEV && sessionId === RECORD_NOTICES_DEMO_SESSION_ID) {
      recordNoticesDemoRef.current?.clear();
      return;
    }
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
    const wasCrossProfileRecording =
      !!owningNoteId && crossProfileRecordingNoteIdRef.current === owningNoteId;
    dispatch({ type: "recordingStatusCleared" });
    setRecordingNote(undefined);
    if (wasCrossProfileRecording && owningNoteId) {
      crossProfileRecordingNoteIdRef.current = undefined;
      const nextTabs = invalidateNoteTabs(tabsRef.current, new Set([owningNoteId]));
      if (nextTabs !== tabsRef.current) {
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
      }
      // The old-profile note was temporarily present only to control the
      // recording. Once the take stops, remove it from the active profile's
      // visible list before any tab or sidebar action can reopen it.
      dispatch({
        type: "notesLoaded",
        notes: state.notes.filter((note) => note.id !== owningNoteId),
      });
      setOriginFolderId(undefined);
      setOriginAllNotes(false);
      setFolderReturnTarget(undefined);
      if (activeViewRef.current === "meetings") setActiveView("notes");
    }
    playRecordingSound("stop");
    // Optimistically flip the note that owns this recording to transcribing.
    // The selected note isn't necessarily that note — the user may have
    // browsed elsewhere while recording — and stamping the wrong note as
    // transcribing would lock its record button and shimmer forever.
    if (selectedNote && selectedNote.id === owningNoteId) {
      dispatch({
        type: "noteProcessingUpdated",
        note: {
          ...selectedNote,
          processingStatus: "transcribing",
          lastError:
            selectedNote.processingStatus === "failed" ||
            selectedNote.processingStatus === "recoverable"
              ? undefined
              : selectedNote.lastError,
        },
      });
    }
    try {
      const result = await finishRecording(sessionId);
      // The result belongs to the profile where recording started. Once that
      // profile's temporary recording view has been retired, do not let the
      // finish response upsert the old note into the newly active profile.
      if (!wasCrossProfileRecording) {
        dispatch({ type: "noteProcessingUpdated", note: result.note });
      }
    } catch (err) {
      if (
        wasCrossProfileRecording ||
        !owningNoteId ||
        !(await applyNoteScopedProcessingFailure(owningNoteId, err))
      ) {
        setError(messageFromError(err));
      }
      if (options.rethrow) throw err;
    } finally {
      if (wasCrossProfileRecording) {
        const finishingProfile = getActiveHermesProfileName();
        try {
          const response = await listNotes();
          if (getActiveHermesProfileName() === finishingProfile) {
            dispatch({ type: "notesLoaded", notes: response.items });
          }
        } catch (refreshErr) {
          if (getActiveHermesProfileName() === finishingProfile) {
            setError(messageFromError(refreshErr));
          }
        }
      }
      finishingSessionsRef.current.delete(sessionId);
    }
  }

  async function applyNoteScopedProcessingFailure(noteId: string, err: unknown) {
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
    // The dev __recordNoticesDemo session has no backend recording; report
    // success without a pauseRecording IPC round-trip. Its own ticker keeps the
    // bar live, so pause is a visual no-op here.
    if (import.meta.env.DEV && sessionId === RECORD_NOTICES_DEMO_SESSION_ID) {
      return true;
    }
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
    // The dev __recordNoticesDemo session has no backend recording; its ticker
    // already keeps the bar in the recording state, so resume is a no-op.
    if (import.meta.env.DEV && sessionId === RECORD_NOTICES_DEMO_SESSION_ID) {
      return;
    }
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
    const timeout = window.setTimeout(
      () => {
        const currentStatus = recordingStatusRef.current;
        const sessionId = recordingInactivityPrompt.sessionId;
        recordingInactivityTrackerRef.current = { sessionId };
        setRecordingInactivityPrompt(null);
        if (currentStatus?.sessionId !== sessionId || currentStatus.state !== "recording") {
          return;
        }
        void handlePauseRecording(sessionId).then((paused) => {
          if (paused) void notifyRecordingAutoPaused(sessionId);
        });
      },
      Math.max(0, recordingInactivityPrompt.expiresAt - Date.now()),
    );

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
    ? Math.max(0, Math.ceil((recordingInactivityPrompt.expiresAt - recordingInactivityNow) / 1000))
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
        <div className="welcome-screen welcome-screen-loading">
          <Spinner size="lg" aria-label="Starting June" />
          <p>Starting June...</p>
        </div>
      </main>
    );
  }

  if (accountError && !account.signedIn && !devAccountsUnconfigured) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <AccountStatusFailure message={accountError} onRetry={refreshAccount} />
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
          onComplete={() => {
            // Read before marking complete: marking writes the completion
            // key that distinguishes a fresh install from a wizard replay.
            const firstOnboardingCompletion = !hasCompletedAnyOnboardingVersion();
            markOnboardingComplete();
            // A background assistant only works while it runs; make sure a
            // fresh install starts at login. One-shot and first-run only: a
            // user who later turns the login item off stays off, and wizard
            // replays never re-enroll existing users.
            void applyAutostartDefaultOnce({ firstOnboardingCompletion });
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

  // The in-note RecorderBar covers the recording while you're looking at its
  // note. Elsewhere, the sidebar header carries a tiny recording presence; the
  // floating pill is only the collapsed-sidebar fallback.
  const viewingRecordingNote =
    activeView === "meetings" && selectedNoteId !== undefined && selectedNoteId === recordingNoteId;
  const recorderPresenceVisible = Boolean(state.recordingStatus) && !viewingRecordingNote;
  const recordingNoteTitle =
    (selectedNote?.id === recordingNoteId
      ? selectedNote?.title
      : state.notes.find((note) => note.id === recordingNoteId)?.title
    )?.trim() || "New note";
  // The dev console demo (window.__globalRecorderPill) force-shows the recorder
  // presence with synthetic status; otherwise it tracks the real recording.
  const recorderPresenceStatus =
    demoRecorderStatus ?? (recorderPresenceVisible ? state.recordingStatus : null);
  const sidebarRecorderStatus =
    recorderPresenceStatus && !sidebarCollapsed && activeView !== "settings"
      ? recorderPresenceStatus
      : null;
  const pillStatus =
    recorderPresenceStatus && !sidebarRecorderStatus ? recorderPresenceStatus : null;
  const pillIsDemo = demoRecorderStatus !== null;

  return (
    <main
      className="app-shell"
      data-platform={isWindowsPlatform() ? "windows" : undefined}
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
        onSettingsTabChange={changeSettingsTab}
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
        onRenameAgentSession={handleRenameAgentSession}
        onSelectAgentSession={(session) => {
          if (takeNewTabIntent()) {
            openTab({ view: "agent", agentSessionId: session.id });
            return;
          }
          setAgentOrigin(undefined);
          setActiveAgentSession(session);
          setActiveView("agent");
        }}
        sessionFolderIds={sessionFolders}
        completedSessionIds={completedSessions}
        onToggleSessionCompleted={handleToggleSessionCompleted}
        onOpenSessionMoveDialog={(sessionId) => setMoveDialogSessionIds([sessionId])}
        onRemoveSessionFromFolder={(sessionId, folderId) =>
          void handleRemoveSessionFromFolder(sessionId, folderId)
        }
        recoverableNoteIds={recoverableNoteIds}
        recordingStatus={sidebarRecorderStatus}
        recordingTitle={recordingNoteTitle}
        onOpenRecording={() => (pillIsDemo ? undefined : void handleOpenRecordingNote())}
        collapsed={sidebarCollapsed}
        footerAccessory={
          <>
            <UpdateHub
              readyUpdate={readyUpdate}
              status={updateStatus}
              failed={updateStatusDisplay.failed}
              statusLeaving={updateStatusLeaving}
              checking={checkingUpdate}
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
            {fundingRequired ? (
              <FundingChip account={fundingAccount} onRefresh={refreshFundingAccount} />
            ) : null}
          </>
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
          onReorder={handleReorderTabs}
          layoutFrozen={sidebarResizing}
          onDragRegionPointerDown={handleTitlebarPointerDown}
        />
        <section className="main-panel">
          {accessibilityBlocked && !accessibilityBannerDismissed ? (
            <PermissionBanner
              onDismiss={() => setAccessibilityBannerDismissed(true)}
              onEnableAccessibility={handleEnableAccessibility}
            />
          ) : null}
          <div
            ref={mainPanelBodyRef}
            className="main-panel-body"
            data-active-view={activeView}
            data-detail-scroller={detailScrollerActive ? "true" : undefined}
            data-note-detail-scroller={
              noteDetailScrollerActive || settingsDetailScrollerActive ? "true" : undefined
            }
          >
            {error ? <p className="error-banner">{error}</p> : null}
            {billingNotice ? (
              <p className="notice-banner" role="status">
                {billingNotice}{" "}
                {appMaxGrantWaitRef.current?.phase === "slow" ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      void osAccountsOpenPortal().catch((err) => setError(messageFromError(err)));
                    }}
                  >
                    {MAX_UPGRADE_PORTAL_LABEL}
                  </button>
                ) : null}
              </p>
            ) : null}
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
                  folders={state.folders}
                  onFoldersImported={handleFoldersImported}
                  memoryFolderFilter={memoryFolderFilter}
                  onOpenProject={(folderId) => {
                    handleSelectFolder(folderId);
                    setActiveView("folders");
                  }}
                  activeTab={settingsTab}
                  onTabChange={changeSettingsTab}
                  onDetailPinnedChange={setSettingsDetailPinned}
                  onCheckForUpdates={() => runUpdateCheck("manual")}
                  updateReadyToRelaunch={readyUpdate != null}
                  onRelaunch={handleRelaunchUpdate}
                  onReconcileToStable={handleReconcileToStable}
                  onReportIssue={handleReportIssue}
                  onStartBundleChat={handleStartBundleChat}
                />
              ) : activeView === "dictation" ? (
                <DictationHistoryView
                  onNavigateToSettings={(target) => {
                    setSettingsReturnView(activeView);
                    setActiveView("settings");
                    setSettingsTab("dictation");
                    const headingId = target === "style" ? "style-heading" : "dictionary-heading";
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
                  creditActionsDisabledReason={
                    fundingRequired ? ROUTINE_FUNDING_DISABLED_REASON : undefined
                  }
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
                  initialSession={activeAgentSessionSeed}
                  initialSessionId={activeAgentSessionId}
                  onSessionSelected={setActiveAgentSession}
                  creditActionsDisabledReason={
                    fundingRequired ? COMPOSER_FUNDING_DISABLED_REASON : undefined
                  }
                  renderFundingNotice={
                    fundingRequired
                      ? (textFundingContext) => (
                          <FundingNotice
                            account={fundingAccount}
                            onRefresh={refreshFundingAccount}
                            textFundingContext={textFundingContext}
                          />
                        )
                      : undefined
                  }
                  fundingTier={fundingTierOf(fundingAccount)}
                  topUpLabel={topUpLabel}
                  onTopUp={handleTopUp}
                  sessionInProject={Boolean(activeAgentSessionFolder)}
                  resolveSessionProjectContext={(sessionId) => {
                    const folder =
                      sessionId === activeAgentSessionId
                        ? activeAgentSessionFolder
                        : selectSessionProjectContext(state.folders, sessionFolders[sessionId]);
                    return folder
                      ? {
                          id: folder.id,
                          name: folder.name,
                          instructions: folder.instructions,
                          localPath: folder.localPath,
                        }
                      : undefined;
                  }}
                  projectContext={
                    agentProjectContextFolder
                      ? {
                          id: agentProjectContextFolder.id,
                          name: agentProjectContextFolder.name,
                          instructions: agentProjectContextFolder.instructions,
                          localPath: agentProjectContextFolder.localPath,
                        }
                      : undefined
                  }
                  onMoveSessionToProject={(sessionId) => setMoveDialogSessionIds([sessionId])}
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
                              icon: <IconProjects size={13} />,
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
                        : activeAgentSessionFolder
                          ? // Opened from the Sessions view or sidebar but filed in a
                            // project: the crumb shows the session's home (back still
                            // returns to where the user came from).
                            {
                              backLabel: "Back to sessions",
                              onBack: handleReturnToAgentsList,
                              crumbs: [
                                {
                                  label: activeAgentSessionFolder.name,
                                  icon: <IconProjects size={13} />,
                                  onClick: () =>
                                    handleOpenSessionProject(activeAgentSessionFolder.id),
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
                  completedSessionIds={completedSessions}
                  onToggleCompleted={handleToggleSessionCompleted}
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
                  onRenameSession={handleRenameAgentSession}
                  onOpenMoveDialog={(sessionId) => setMoveDialogSessionIds([sessionId])}
                  onOpenMoveSessions={(sessionIds) => setMoveDialogSessionIds(sessionIds)}
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
                          onBack: () => void handleReturnToNote(folderReturnTarget.noteId),
                        }
                      : undefined
                  }
                  onSelectFolder={(folderId) => handleSelectFolder(folderId)}
                  onCreateFolder={(name, description) => handleCreateFolder(name, description)}
                  onFoldersImported={handleFoldersImported}
                  onRenameFolder={(folderId, name, description) =>
                    handleRenameFolder(folderId, name, description)
                  }
                  onFolderUpdated={(folder) => dispatch({ type: "folderUpdated", folder })}
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
                      void handleSelectNote(noteId).then(() => setActiveView("meetings"));
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
                  onCreateSession={(folderId) => handleNewAgentSessionInProject(folderId)}
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
                  onOpenSessionMoveDialog={(sessionId) => setMoveDialogSessionIds([sessionId])}
                  onManageProjectMemory={(folderId) => openMemorySettings(folderId)}
                />
              ) : selectedNote ? (
                <div className="note-shell">
                  {/* Every note gets the toolbar so its content starts at a
                      consistent height (aligning with the Ask June panel) and
                      the note actions live in one predictable spot. The left
                      shows breadcrumb nav when there's a parent, else a quiet
                      "Notes" root. */}
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
                          icon: <IconProjects size={13} />,
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
                          action: noteShareUrl ? <ShareLinkCopyAction url={noteShareUrl} /> : null,
                        },
                      ]}
                      actions={noteToolbarActions}
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
                          action: noteShareUrl ? <ShareLinkCopyAction url={noteShareUrl} /> : null,
                        },
                      ]}
                      actions={noteToolbarActions}
                    />
                  ) : (
                    <BreadcrumbBar
                      items={[
                        { label: "Notes", onClick: () => setActiveView("all-notes") },
                        {
                          label: selectedNote.title.trim() || "New note",
                          action: noteShareUrl ? <ShareLinkCopyAction url={noteShareUrl} /> : null,
                        },
                      ]}
                      actions={noteToolbarActions}
                    />
                  )}
                  <div
                    ref={noteDetailScrollRef}
                    className="note-detail-scroll"
                    data-has-detail-bar="true"
                  >
                    <NoteEditor
                      note={selectedNote}
                      transcriptScrollRef={noteDetailScrollRef}
                      folders={state.folders}
                      recordingStatus={
                        selectedNoteId === recordingNoteId ? state.recordingStatus : undefined
                      }
                      recordingDisabled={Boolean(
                        state.recordingStatus && selectedNoteId !== recordingNoteId,
                      )}
                      recordingBlockedReason={
                        fundingRequired ? RECORDING_FUNDING_DISABLED_REASON : undefined
                      }
                      fundingNotice={
                        fundingRequired ? (
                          <FundingNotice
                            account={fundingAccount}
                            onRefresh={refreshFundingAccount}
                          />
                        ) : undefined
                      }
                      fundingTier={fundingTierOf(fundingAccount)}
                      retryBlockedReason={
                        fundingRequired ? NOTE_RETRY_FUNDING_DISABLED_REASON : undefined
                      }
                      recoveryBlockedReason={
                        fundingRequired ? RECOVERY_FUNDING_DISABLED_REASON : undefined
                      }
                      liveTranscript={selectedNoteLiveTranscript}
                      sourceMode={sourceMode}
                      sourceReadiness={sourceReadiness}
                      recovery={selectedRecovery}
                      onRecoverRecording={(sessionId) => handleRecovery(sessionId, "validate")}
                      onDiscardRecording={(sessionId) => handleRecovery(sessionId, "discard")}
                      onTitleChange={(title) => void handleUpdateNote({ title })}
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
                      consentReminderPinned={
                        import.meta.env.DEV &&
                        recordNoticesConsentPinned &&
                        selectedNoteId === recordingNoteId
                      }
                      onTabChange={(activeTab) =>
                        void updateNote({
                          noteId: selectedNote.id,
                          activeTab,
                        }).then((note) => dispatch({ type: "noteUpdated", note }))
                      }
                      onStartRecording={() => void handleStartRecording()}
                      onPauseRecording={(sessionId) => void handlePauseRecording(sessionId)}
                      onResumeRecording={(sessionId) => void handleResumeRecording(sessionId)}
                      onFinishRecording={(sessionId) => void handleFinishRecording(sessionId)}
                      onRetry={async () => {
                        if (!selectedNote) return;
                        if (fundingRequired) {
                          setError(NOTE_RETRY_FUNDING_DISABLED_REASON);
                          return;
                        }
                        try {
                          const note = await retryProcessing(
                            selectedNote.id,
                            selectedNote.retryRecordingSessionId,
                          );
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
                      onTopUp={handleTopUp}
                      topUpLabel={topUpLabel}
                      onAssignFolder={(folderId) =>
                        void handleSetNoteFolder(selectedNote.id, folderId)
                      }
                      onRemoveFolder={(folderId) =>
                        void handleRemoveNoteFromFolder(selectedNote.id, folderId)
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
                            await handleSetNoteFolder(selectedNote.id, folder.id);
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
                  onOpen={() => (pillIsDemo ? undefined : void handleOpenRecordingNote())}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
        {activeView === "meetings" && selectedNote && noteChatOpen ? (
          <NoteChatPanel
            note={{ id: selectedNote.id, title: selectedNote.title }}
            chat={noteChat}
            recordingActive={captureActive}
            creditActionsDisabledReason={
              fundingRequired ? COMPOSER_FUNDING_DISABLED_REASON : undefined
            }
            renderFundingNotice={
              fundingRequired
                ? (textFundingContext) => (
                    <FundingNotice
                      account={fundingAccount}
                      onRefresh={refreshFundingAccount}
                      textFundingContext={textFundingContext}
                    />
                  )
                : undefined
            }
            onClose={() => setNoteChatOpen(false)}
            onOpenInAgent={(sessionId) => {
              setNoteChatOpen(false);
              handleOpenNoteChatInAgent(
                { id: selectedNote.id, title: selectedNote.title },
                sessionId,
              );
            }}
          />
        ) : null}
        <ConfirmDialog
          open={confirmDeleteNote && !!selectedNote}
          onClose={() => setConfirmDeleteNote(false)}
          onConfirm={async () => {
            setConfirmDeleteNote(false);
            if (selectedNote) await handleDeleteNote(selectedNote.id);
          }}
          title="Delete note?"
          description="This permanently deletes the note and its transcript. This can't be undone."
          confirmLabel="Delete note"
          destructive
        />
        {selectedNote ? (
          <ShareDialog
            key={selectedNote.id}
            open={shareNoteOpen}
            onClose={() => setShareNoteOpen(false)}
            onLinkChange={setNoteShareUrl}
            item={{
              kind: "note",
              itemId: selectedNote.id,
              title: selectedNote.title,
              // Notes share the rendered markdown: edited content when
              // present, generated otherwise. Snapshot at share time.
              buildPayload: () =>
                buildNotePayload({
                  title: selectedNote.title,
                  markdown: selectedNote.editedContent ?? selectedNote.generatedContent ?? "",
                }),
            }}
          />
        ) : null}
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
            June will pause this recording in {recordingInactivitySecondsRemaining} seconds if you
            do not answer.
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
        onSetFolder={(noteId, folderId) => handleSetNoteFolder(noteId, folderId, { rethrow: true })}
        onCreateFolder={(name) => handleCreateFolder(name)}
        onRemoveFolder={(noteId, folderId) =>
          handleRemoveNoteFromFolder(noteId, folderId, { rethrow: true })
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
                .filter((session): session is HermesSessionInfo => session !== undefined)
            : []
        }
        sessionFolderIds={sessionFolders}
        folders={state.folders}
        onSetFolder={(sessionId, folderId) =>
          handleSetSessionFolder(sessionId, folderId, { rethrow: true })
        }
        onCreateFolder={(name) => handleCreateFolder(name)}
        onRemoveFolder={(sessionId, folderId) =>
          handleRemoveSessionFromFolder(sessionId, folderId, { rethrow: true })
        }
        onMoved={() => agentSessionsListRef.current?.resetSelection()}
      />
      <ConfirmDialog
        open={maxUpgradePrompt !== null}
        onClose={() => setMaxUpgradePrompt(null)}
        onConfirm={confirmMaxUpgrade}
        title={MAX_UPGRADE_CONFIRM_TITLE}
        description={
          maxUpgradeError ??
          (maxUpgradePrompt?.transport === "charge_now"
            ? MAX_UPGRADE_CHARGE_CONFIRM_BODY
            : MAX_UPGRADE_CONFIRM_BODY)
        }
        confirmLabel={MAX_UPGRADE_CONFIRM_LABEL}
        confirmBusyLabel={MAX_UPGRADE_BUSY_LABEL}
      />
      {/* Connector action approvals (approval trust mode) can arrive from a
          routine or chat in any view, so the tray is mounted at the shell. */}
      <div className="shell-approvals-stack">
        <ComputerUseApprovalsTray />
        <ConnectorApprovalsTray />
      </div>
      {/* The referral delight nudge floats bottom-left at the shell so it can
          appear over any view; click-through opens the sidebar-owned referral
          dialog by event. */}
      {referralNudgeMoment ? (
        <ReferralNudge
          moment={referralNudgeMoment}
          onInvite={() => {
            // Ends all future nudging, per the frequency rules — but only for
            // real trigger shows; demo cards must not poison the caps.
            if (referralNudgeSourceRef.current === "trigger") markReferralNudgeClickedThrough();
            setReferralNudgeMoment(null);
            window.dispatchEvent(new Event(OPEN_REFERRAL_DIALOG_EVENT));
          }}
          onDismiss={() => setReferralNudgeMoment(null)}
        />
      ) : null}
    </main>
  );
}

// The collapsed transform is driven by `aria-pressed` on the parent button.
