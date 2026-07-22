import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AccountGate, AccountStatusFailure } from "../components/account/AccountGate";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSION_RENAMED_EVENT,
  markAgentNewSessionPending,
  recordManualAgentSessionTitle,
  type AgentNewSessionDetail,
  type AgentSessionRenamedDetail,
} from "../components/agent/AgentWorkspace";
import type { AgentSessionsListHandle } from "../components/agent/AgentSessionsList";
import type { ReportCategory } from "../components/agent/composer/reportCategory";
import { NoteHeaderActions } from "../components/note-editor/NoteHeaderActions";
import { toast } from "../components/ui/Toaster";
import { exportNoteAsPdf } from "../lib/note-pdf";
import { useNoteChat } from "../components/note-chat/useNoteChat";
import { noteReadyToShare } from "../lib/share-payload";
import type { GlobalRecorderDemoApi } from "../lib/global-recorder-demo";
import type { RecordNoticesDemoApi } from "../lib/record-notices-demo";
import type { UpdateCardDemoApi } from "../lib/update-card-demo";
import { type NotesListHandle } from "../components/notes-list/NotesList";
import { SETTINGS_TABS, type SettingsTab } from "../components/settings/AppSettings";
import { type SidebarView } from "../components/sidebar/Sidebar";
import { type TabItem } from "../components/tabs/TabBar";
import { defaultNav, makeTabId, reorderTabs, type Tab, type TabNav } from "./tabs/tabs";
import { type ReferralNudgeMoment } from "../components/referral/ReferralNudge";
import { recordDictationFinished } from "../lib/referral-nudge";
import { useReferralNudgeTriggers } from "./referral-nudge-triggers";
import { Spinner } from "../components/ui/Spinner";
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
  downloadNoteAudio,
  ensureHermesBridgeSession,
  getRecordingStatus,
  getNote,
  LIVE_TRANSCRIPT_EVENT,
  NOTE_CALENDAR_CONTEXT_UPDATED_EVENT,
  listCompletedSessions,
  listNotes,
  listSessionFolders,
  listSessionProfiles,
  openPrivacySettings,
  osAccountsLogout,
  removeNoteFromFolder,
  removeSessionFromFolder,
  recoverRecording,
  revealPath,
  renameFolder,
  setSessionCompleted,
  updateNote,
  agentHudHide,
  agentHudShow,
  type LiveTranscriptEventDto,
} from "../lib/tauri";
import { preloadRecordingSounds } from "../lib/recording-sounds";
import { preloadAgentSounds } from "../lib/agent-sounds";
import { isMacLikePlatform, isPrimaryShortcut, isWindowsPlatform } from "../lib/platform";
import {
  AGENT_GALLERY_EVENT,
  dispatchAgentSessionStatus,
  emitAgentSessionsChanged,
  type AgentGalleryDetail,
  type AgentSessionStatusDetail,
} from "../lib/agent-events";
import { selectSessionProjectContext } from "../lib/agent-project-context";
import { rememberSessionManuallyTitled } from "../lib/agent-session-titles";
import { messageFromError } from "../lib/errors";
import { nextDictationWorkflowActive, parseDictationHelperEvent } from "../lib/dictation-events";
import { listHermesSessions, titleFromPrompt } from "../lib/hermes-adapter";
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
import type { RecordingSourceMode, RecordingSourceReadinessDto } from "../lib/tauri";
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
  depletedBalanceActionLabel,
  shouldBlockOnFunding,
  shouldBlockOnSignIn,
} from "../lib/account-gate";
import { type MaxUpgradeTransport } from "../lib/billing-actions";
import { type MaxGrantWait } from "../lib/max-upgrade";
import { checkJuneUpdate, reconcileToStable, relaunchJune, type JuneUpdate } from "../lib/updater";
import {
  PROCESSING_DEMO_NOTE_ID,
  RECORD_NOTICES_DEMO_SESSION_ID,
  shouldPollProcessingStatus,
} from "./processing-polling";
import { attachScrollThumbFade } from "../lib/scroll-thumb-fade";
import { createInitialState, notesReducer } from "./state/app-state";
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
import {
  handleTitlebarPointerDown,
  isAccessibilityBlocked,
  isAppErrorCode,
  isCreateNoteShortcut,
  isMicrophoneRecordingBlocked,
  isNewSessionShortcut,
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
  RECOVERY_FUNDING_DISABLED_REASON,
  SIDEBAR_DEFAULT_WIDTH,
  SYSTEM_AUDIO_PERMISSION_REFRESH_INTERVAL_MS,
  SYSTEM_AUDIO_PERMISSION_REFRESH_TIMEOUT_MS,
  UP_TO_DATE_DISMISS_MS,
  UP_TO_DATE_EXIT_MS,
  noteHasDownloadableAudio,
  tabMeta,
  type RecordingInactivityPrompt,
} from "./app-shell";

import { useAppExternalEvents } from "./use-app-external-events";

import { useAgentAttentionNotifications } from "./use-agent-attention-notifications";

import { useAgentMenuSessions } from "./use-agent-menu-sessions";

import { useAgentSessionSync } from "./use-agent-session-sync";

import { useAgentMenuEvents } from "./use-agent-menu-events";

import { useActiveProfileData } from "./use-active-profile-data";

import { useRecordingStartActions } from "./use-recording-start-actions";

import { useRecordingEvents } from "./use-recording-events";

import { useRecordingControls } from "./use-recording-controls";

import { useAccountActions } from "./use-account-actions";

import { useAppNavigation } from "./use-app-navigation";

import { renderAppWorkspace } from "./app-workspace-view";

import { renderAppLayout } from "./app-layout";

import { createAppDomainActions } from "./app-domain-actions";

import { useAppUpdateActions } from "./use-app-update-actions";

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
  const { confirmMaxUpgrade, handleTopUp } = useAccountActions({
    account,
    appMaxGrantWaitRef,
    billingNoticeTimerRef,
    maxUpgradePrompt,
    refreshAccount,
    setBillingNotice,
    setError,
    setMaxUpgradeError,
    setMaxUpgradePrompt,
    showBillingNotice,
  });
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
  const { applyNav, activateTab, openTab, openNewChatTab, closeTab, selectedNoteIdRef } =
    useAppNavigation({
      activeAgentSessionId,
      activeAgentSessionSeed,
      activeTabId,
      activeTabIdRef,
      activeView,
      activeViewRef,
      agentOrigin,
      agentSessions,
      dispatch,
      originAllNotes,
      originFolderId,
      pendingSessionProjectRef,
      restoreTargetRef,
      selectedNoteId,
      setActiveAgentSession,
      setActiveAgentSessionId,
      setActiveAgentSessionSeed,
      setActiveTabId,
      setActiveView,
      setAgentOrigin,
      setError,
      setFolderReturnTarget,
      setOriginAllNotes,
      setOriginFolderId,
      setSettingsReturnView,
      setTabs,
      state,
      tabs,
      tabsRef,
    });

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

  const { runUpdateCheck } = useAppUpdateActions({
    checkingUpdateRef,
    preparingUpdateRef,
    readyUpdateRef,
    relaunchingUpdateRef,
    setCheckingUpdate,
    setPreparingUpdate,
    setReadyUpdate,
    setUpdateProgress,
    setUpdateStatus,
    updateProgressHiddenRef,
  });

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

  useAgentSessionSync({
    activeViewRef,
    agentMenuBarLastStatusRef,
    agentMenuBarSessionsRef,
    agentMenuBarWaitingSessionIdsRef,
    agentMenuBarWorkingSessionIdsRef,
    commitAgentSessions,
    pendingSessionProjectRef,
    publishAgentMenuBarState,
    refreshSessionProfiles,
    setActiveAgentSession,
    setActiveAgentSessionId,
    setActiveAgentSessionSeed,
    setAgentOrigin,
    setAgentSessions,
    setAgentWaitingSessionIds,
    setAgentWorkingSessionIds,
    setSessionFolders,
  });

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

  useAgentMenuEvents({
    agentMenuBarSessionsRef,
    handleAgentHudVisibilityRequest,
    pendingSessionProjectRef,
    profileScopedAgentSessions,
    publishAgentMenuBarState,
    refreshSessionProfiles,
    setActiveAgentSession,
    setActiveAgentSessionId,
    setActiveAgentSessionSeed,
    setActiveView,
    setAgentOrigin,
  });

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
  useActiveProfileData({
    activeHermesProfileName,
    activeViewRef,
    appBlocked,
    bootstrapped,
    commitAgentSessions,
    crossProfileRecordingNoteIdRef,
    dispatch,
    lastDataProfileRef,
    lastProfileDataRefreshRevisionRef,
    pendingSessionProjectRef,
    profileDataRefreshRevision,
    recordingNoteIdRef,
    refreshSessionProfiles,
    setActiveAgentSession,
    setActiveView,
    setAgentOrigin,
    setError,
    setFolderReturnTarget,
    setOriginAllNotes,
    setOriginFolderId,
    setTabs,
    tabsRef,
  });

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

  const {
    handleDeleteFolder,
    handleRemoveNoteFromFolder,
    handleSetNoteFolder,
    handleSetSessionFolder,
    handleToggleSessionCompleted,
    handleRemoveSessionFromFolder,
    handleReportIssue,
    handleOpenNoteChatInAgent,
    handleAskJuneAboutNote,
    handleStartBundleChat,
    handleNewAgentSessionInProject,
  } = createAppDomainActions({
    agentSessions,
    completedSessions,
    dispatch,
    pendingSessionProjectRef,
    sessionCompletionTouchedRef,
    sessionCompletionWritesRef,
    sessionFolders,
    setActiveAgentSession,
    setActiveView,
    setAgentOrigin,
    setCompletedSessions,
    setError,
    setSessionFolders,
    state,
  });

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

  const {
    handleStartRecording,
    meetingStartReadyRef,
    meetingStartListenerRegisteredRef,
    drainPendingMeetingStartRef,
    handleStartMeetingDetectedRecording,
    handleStartAgentRecording,
    handleOpenRecordingNote,
  } = useRecordingStartActions({
    activeViewRef,
    appBlocked,
    bootstrapped,
    calendarContextNoteProfilesRef,
    calendarContextNoteUpdatesRef,
    dispatch,
    fundingRequired,
    handleEmptyNotesAfterDelete,
    pendingCalendarContextAdoptionsRef,
    recordingNoteIdRef,
    recordingStartInFlightRef,
    recordingStatusRef,
    selectedNoteId,
    selectedNoteIdRef,
    setActiveView,
    setCheckingSourceReadiness,
    setError,
    setFolderReturnTarget,
    setOriginAllNotes,
    setOriginFolderId,
    setRecordingNote,
    setSourceReadiness,
    sourceMode,
  });

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

  useRecordingEvents({
    drainPendingMeetingStartRef,
    meetingStartHandlerRef,
    meetingStartListenerRegisteredRef,
    meetingStartReadyRef,
    setError,
  });

  // The handler closes over frequently-changing state, but the Tauri listener
  // must register exactly once: re-subscribing tears the listener down and
  // events emitted in the gap are silently dropped (a dropped request costs
  // the agent a full proxy lease). The ref always holds the latest closure.
  const {
    applyNoteScopedProcessingFailure,
    handleFinishRecording,
    handlePauseRecording,
    handleResumeRecording,
  } = useRecordingControls({
    activeViewRef,
    appBlocked,
    bootstrapped,
    crossProfileRecordingNoteIdRef,
    dispatch,
    finishingSessionsRef,
    handleStartAgentRecording,
    recordNoticesDemoRef,
    recordingNoteIdRef,
    recordingStatusRef,
    selectedNote,
    setActiveView,
    setError,
    setFolderReturnTarget,
    setOriginAllNotes,
    setOriginFolderId,
    setRecordingNote,
    setTabs,
    state,
    tabsRef,
  });

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

  const workspaceContent = renderAppWorkspace({
    accessibilityStatus,
    account,
    accountLoading,
    activeAgentSessionFolder,
    activeAgentSessionId,
    activeAgentSessionSeed,
    activeView,
    agentOrigin,
    agentOriginFolder,
    agentProjectContextFolder,
    agentSessions,
    agentSessionsListRef,
    agentWaitingSessionIds,
    agentWorkingSessionIds,
    changeSettingsTab,
    checkingSourceReadiness,
    completedSessions,
    dispatch,
    folderReturnTarget,
    fundingAccount,
    fundingRequired,
    handleAccountChanged,
    handleCreateFolder,
    handleCreateNote,
    handleDeleteFolder,
    handleDeleteNote,
    handleDeleteNotes,
    handleEnableAccessibility,
    handleEnableMicrophone,
    handleEnableSystemAudio,
    handleFinishRecording,
    handleFoldersImported,
    handleNewAgentSession,
    handleNewAgentSessionInProject,
    handleOpenSessionProject,
    handlePauseRecording,
    handleReconcileToStable,
    handleRecovery,
    handleRelaunchUpdate,
    handleRemoveNoteFromFolder,
    handleRemoveSessionFromFolder,
    handleRenameAgentSession,
    handleRenameFolder,
    handleReportIssue,
    handleResumeRecording,
    handleReturnToAgentOriginFolder,
    handleReturnToAgentsList,
    handleReturnToNote,
    handleReturnToRoutines,
    handleSelectFolder,
    handleSelectNote,
    handleSelectNoteFromAllNotes,
    handleSelectNoteFromFolder,
    handleSetNoteFolder,
    handleSetSessionFolder,
    handleSourceModeChange,
    handleStartBundleChat,
    handleStartRecording,
    handleToggleSessionCompleted,
    handleTopUp,
    handleUpdateNote,
    memoryFolderFilter,
    microphoneBlocked,
    microphoneStatus,
    noteDetailScrollRef,
    noteShareUrl,
    noteToolbarActions,
    notesListRef,
    openMemorySettings,
    openTab,
    originAllNotes,
    originFolder,
    readyUpdate,
    recordNoticesConsentPinned,
    recordingNoteId,
    refreshAccount,
    refreshFundingAccount,
    runUpdateCheck,
    selectedNote,
    selectedNoteId,
    selectedNoteLiveTranscript,
    selectedRecovery,
    sessionFolders,
    setActiveAgentSession,
    setActiveView,
    setAgentOrigin,
    setError,
    setFolderReturnTarget,
    setMoveDialogNoteIds,
    setMoveDialogSessionIds,
    setOriginAllNotes,
    setOriginFolderId,
    setSettingsDetailPinned,
    setSettingsReturnView,
    setSettingsTab,
    settingsTab,
    sourceMode,
    sourceReadiness,
    state,
    takeNewTabIntent,
    topUpLabel,
  });

  return renderAppLayout({
    accessibilityBannerDismissed,
    accessibilityBlocked,
    account,
    activateTab,
    activeTabId,
    activeView,
    agentSessions,
    agentSessionsListRef,
    appMaxGrantWaitRef,
    billingNotice,
    captureActive,
    changeSettingsTab,
    checkingUpdate,
    closeOtherTabs,
    closeTab,
    completedSessions,
    confirmDeleteNote,
    confirmMaxUpgrade,
    detailScrollerActive,
    dispatch,
    error,
    fundingAccount,
    fundingRequired,
    handleCreateFolder,
    handleDeleteNote,
    handleEnableAccessibility,
    handleKeepRecordingAfterInactivityPrompt,
    handleOpenNoteChatInAgent,
    handleOpenRecordingNote,
    handlePauseRecordingAfterInactivityPrompt,
    handleRelaunchUpdate,
    handleRemoveNoteFromFolder,
    handleRemoveSessionFromFolder,
    handleRenameAgentSession,
    handleReorderTabs,
    handleReportIssue,
    handleSelectNote,
    handleSetNoteFolder,
    handleSetSessionFolder,
    handleSignOut,
    handleToggleSessionCompleted,
    mainPanelBodyRef,
    maxUpgradeError,
    maxUpgradePrompt,
    moveDialogNoteIds,
    moveDialogSessionIds,
    noteChat,
    noteChatOpen,
    noteDetailScrollerActive,
    notesListRef,
    openNewChatTab,
    openSettings,
    openTab,
    pendingSessionProjectRef,
    pillIsDemo,
    pillStatus,
    preparingUpdate,
    readyUpdate,
    recordingInactivityPrompt,
    recordingInactivitySecondsRemaining,
    recordingNoteTitle,
    recoverableNoteIds,
    referralNudgeMoment,
    referralNudgeSourceRef,
    refreshFundingAccount,
    relaunchingUpdate,
    selectedNote,
    sessionFolders,
    setAccessibilityBannerDismissed,
    setActiveAgentSession,
    setActiveView,
    setAgentOrigin,
    setConfirmDeleteNote,
    setError,
    setFolderReturnTarget,
    setMaxUpgradePrompt,
    setMoveDialogNoteIds,
    setMoveDialogSessionIds,
    setNoteChatOpen,
    setNoteShareUrl,
    setOriginAllNotes,
    setOriginFolderId,
    setReferralNudgeMoment,
    setShareNoteOpen,
    setSidebarCollapsed,
    setSidebarResizing,
    setSidebarTransition,
    setSidebarWidth,
    setUpdateProgress,
    setUpdateStatus,
    settingsDetailScrollerActive,
    settingsReturnView,
    settingsTab,
    shareNoteOpen,
    sidebarCollapsed,
    sidebarRecorderStatus,
    sidebarResizing,
    sidebarTransition,
    sidebarWidth,
    state,
    tabItems,
    takeNewTabIntent,
    updateProgress,
    updateProgressHiddenRef,
    updateStatus,
    updateStatusDisplay,
    updateStatusLeaving,
    workspaceContent,
  });
}

// The collapsed transform is driven by `aria-pressed` on the parent button.
