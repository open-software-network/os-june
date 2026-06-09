import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { AccountGate } from "../components/account/AccountGate";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  AgentWorkspace,
  markAgentNewSessionPending,
  type AgentNewSessionDetail,
  type AgentSessionsChangedDetail,
} from "../components/agent/AgentWorkspace";
import { DictationHistoryView } from "../components/dictation/DictationHistoryView";
import { FoldersWorkspace } from "../components/folders/FoldersWorkspace";
import { MoveNoteToFolderDialog } from "../components/folders/MoveNoteToFolderDialog";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import { NotesList } from "../components/notes-list/NotesList";
import { PermissionBanner } from "../components/permissions/PermissionBanner";
import {
  AppSettings,
  type SettingsTab,
} from "../components/settings/AppSettings";
import { Sidebar, type SidebarView } from "../components/sidebar/Sidebar";
import { BreadcrumbBar } from "../components/ui/BreadcrumbBar";
import { Dialog } from "../components/ui/Dialog";
import {
  assignNoteToFolder,
  bootstrapApp,
  checkRecordingSourceReadiness,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  dictationHelperCommand,
  finishRecording,
  getRecordingStatus,
  getNote,
  listNotes,
  openPrivacySettings,
  osAccountsLogout,
  osAccountsTopUp,
  pauseRecording,
  removeNoteFromFolder,
  recoverRecording,
  renameFolder,
  resumeRecording,
  retryProcessing,
  startRecording,
  updateNote,
} from "../lib/tauri";
import {
  playRecordingSound,
  preloadRecordingSounds,
} from "../lib/recording-sounds";
import { MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import {
  AGENT_OPEN_EVENT,
  AGENT_REPLY_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  dispatchAgentSessionStatus,
  type AgentReplyDetail,
  type AgentSessionStatusDetail,
} from "../lib/agent-events";
import { notifyAgentSessionStatus } from "../lib/agent-notifications";
import { parseDictationHelperEvent } from "../lib/dictation-events";
import { listHermesSessions, titleFromPrompt } from "../lib/hermes-adapter";
import {
  AGENT_MENU_BAR_NEW_SESSION_EVENT,
  AGENT_MENU_BAR_OPEN_SESSION_EVENT,
  buildAgentMenuBarState,
  emitAgentMenuBarState,
} from "../lib/menu-bar";
import type {
  BootstrapResponse,
  NoteDto,
  RecordingStatusDto,
  AccountStatus,
  HermesSessionInfo,
} from "../lib/tauri";
import type {
  RecordingSourceMode,
  RecordingSourceReadinessDto,
} from "../lib/tauri";
import { useAccountStatus } from "../lib/account-status";
import { shouldBlockOnSignIn } from "../lib/account-gate";
import {
  checkScribeUpdate,
  relaunchScribe,
  type ScribeUpdate,
} from "../lib/updater";
import { shouldPollProcessingStatus } from "./processing-polling";
import { createInitialState, notesReducer } from "./state/app-state";
import {
  checkForScribeUpdate,
  installScribeUpdate,
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

export function App() {
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
  const [activeView, setActiveView] = useState<SidebarView>("notes");
  const [activeAgentSession, setActiveAgentSession] =
    useState<HermesSessionInfo>();
  const [pendingAgentReply, setPendingAgentReply] =
    useState<AgentReplyDetail>();
  const agentMenuBarSessionsRef = useRef<HermesSessionInfo[]>([]);
  const agentMenuBarWorkingSessionIdsRef = useRef<Set<string>>(new Set());
  const agentMenuBarWaitingSessionIdsRef = useRef<Set<string>>(new Set());
  const agentMenuBarLastStatusRef = useRef<AgentSessionStatusDetail>();
  // Where the back affordance in settings returns to — captured when settings
  // is opened so "back" lands the user where they were, not on Notes.
  const [settingsReturnView, setSettingsReturnView] =
    useState<SidebarView>("notes");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [originFolderId, setOriginFolderId] = useState<string | undefined>();
  // Tracks that the open note was drilled into from the All notes view, so the
  // note shows the same back-arrow + breadcrumb chrome folders use. Cleared
  // whenever a note is opened from anywhere else (e.g. the sidebar list).
  const [originAllNotes, setOriginAllNotes] = useState(false);
  const [folderReturnTarget, setFolderReturnTarget] = useState<
    { noteId: string; label: string } | undefined
  >();
  const [moveDialogNoteId, setMoveDialogNoteId] = useState<string | null>(null);
  // User's intent for system audio. Defaults true ("record everything").
  // The actual sourceMode is derived below so that granting/revoking
  // permission in System Settings flips the toggle without losing intent.
  const [userWantsSystemAudio, setUserWantsSystemAudio] = useState(true);
  const [sourceReadiness, setSourceReadiness] =
    useState<RecordingSourceReadinessDto>();
  const [checkingSourceReadiness, setCheckingSourceReadiness] = useState(false);
  const [accessibilityStatus, setAccessibilityStatus] = useState<string>();
  const [microphoneStatus, setMicrophoneStatus] = useState<string>();
  const [pendingUpdate, setPendingUpdate] =
    useState<UpdatePromptPayload<ScribeUpdate> | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
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
    loading: accountLoading,
    refresh: refreshAccount,
    setAccount,
  } = useAccountStatus();
  const startOnFreshNoteRef = useRef(false);
  // The note the active recording session belongs to. recordingStatus carries
  // no noteId, so without this the finish flow could only guess from the
  // currently selected note — wrong whenever the user browsed away while
  // recording.
  const recordingNoteIdRef = useRef<string | undefined>(undefined);
  // Sessions with a finishRecording call in flight; guards stop double-clicks.
  const finishingSessionsRef = useRef<Set<string>>(new Set());
  const signInRequired = shouldBlockOnSignIn(account);
  const appBlocked = accountLoading || signInRequired;
  const publishAgentMenuBarState = useCallback(() => {
    void emitAgentMenuBarState(
      buildAgentMenuBarState({
        sessions: agentMenuBarSessionsRef.current,
        workingSessionIds: agentMenuBarWorkingSessionIdsRef.current,
        waitingSessionIds: agentMenuBarWaitingSessionIdsRef.current,
        lastStatus: agentMenuBarLastStatusRef.current,
        limit: AGENT_MENU_BAR_SESSION_LIMIT,
      }),
    );
  }, []);
  const selectedNote = state.selectedNote;
  const selectedNoteId = selectedNote?.id;
  const originFolder = originFolderId
    ? state.folders.find((folder) => folder.id === originFolderId)
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

  function handleRecovery(sessionId: string, action: "validate" | "discard") {
    void recoverRecording(sessionId, action)
      .then((note) => {
        dispatch({ type: "noteProcessingUpdated", note });
        dispatch({ type: "recoveryRemoved", sessionId });
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }

  const handleAccountChanged = useCallback(
    (nextAccount: AccountStatus) => {
      if (signInRequired && !shouldBlockOnSignIn(nextAccount)) {
        startOnFreshNoteRef.current = true;
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

  // installingUpdate is read through a ref so runUpdateCheck keeps a stable
  // identity across installs. Otherwise the launch effect and the manual-check
  // listener below would tear down and re-fire every time installingUpdate
  // toggles — re-triggering an unwanted launch-time check after an install.
  const installingUpdateRef = useRef(false);
  useEffect(() => {
    installingUpdateRef.current = installingUpdate;
  }, [installingUpdate]);

  const runUpdateCheck = useCallback((mode: "launch" | "manual") => {
    if (installingUpdateRef.current) return;
    setUpdateStatus(mode === "manual" ? "Checking for updates..." : null);
    void checkForScribeUpdate(
      {
        check: checkScribeUpdate,
        prompt: (payload) => {
          setUpdateStatus(null);
          setUpdateProgress(null);
          setPendingUpdate(payload);
        },
        reportNoUpdate: () => setUpdateStatus("OS June is up to date."),
        reportFailure: (message) =>
          setUpdateStatus(`Update check failed: ${message}`),
      },
      mode,
    );
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
    function openAgentWorkspace(session?: HermesSessionInfo) {
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
    function handleReply(detail?: AgentReplyDetail) {
      if (!detail?.text.trim()) return;
      setActiveAgentSession(detail.session);
      setPendingAgentReply(detail);
      setActiveView("agent");
    }

    function handleReplyEvent(event: Event) {
      handleReply((event as CustomEvent<AgentReplyDetail>).detail);
    }

    let aborted = false;
    let unlisten: (() => void) | undefined;
    window.addEventListener(AGENT_REPLY_EVENT, handleReplyEvent);
    void listen<AgentReplyDetail>(AGENT_REPLY_EVENT, (event) => {
      handleReply(event.payload);
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      aborted = true;
      unlisten?.();
      window.removeEventListener(AGENT_REPLY_EVENT, handleReplyEvent);
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

  useEffect(() => {
    function handleSessionsChanged(event: Event) {
      const detail = (event as CustomEvent<AgentSessionsChangedDetail>).detail;
      if (!detail) return;
      agentMenuBarSessionsRef.current = detail.sessions;
      agentMenuBarWorkingSessionIdsRef.current = new Set(
        detail.workingSessionIds,
      );
      agentMenuBarWaitingSessionIdsRef.current = new Set(
        detail.waitingSessionIds ?? [],
      );
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
      agentMenuBarWorkingSessionIdsRef.current.delete(sessionId);
      agentMenuBarWaitingSessionIdsRef.current.delete(sessionId);
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

    return () => {
      aborted = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [publishAgentMenuBarState]);

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
          setBootstrapped(true);
          return;
        }
        if (startOnFreshNoteRef.current || seeded.payload.notes.length === 0) {
          startOnFreshNoteRef.current = false;
          const note = await createNote(undefined);
          dispatch({ type: "noteLoaded", note });
          setActiveView("meetings");
          setBootstrapped(true);
          return;
        }
        const firstNoteId = seeded.payload.notes[0]?.id;
        if (firstNoteId) {
          const note = await getNote(firstNoteId);
          dispatch({ type: "noteLoaded", note });
        } else {
          setActiveView("settings");
        }
        setBootstrapped(true);
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [appBlocked]);

  // Probe with "microphonePlusSystem" on mount so sourceReadiness always
  // has the system source. The helper's preflight surfaces the native
  // TCC prompt on first install as a side-effect of this call.
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
  // returns to OS Scribe. The helper poll is what surfaces fresh mic /
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
    void dictationHelperCommand({ type: "request_accessibility_permission" })
      .catch(() => undefined)
      .finally(() => {
        window.setTimeout(() => {
          void openPrivacySettings("accessibility");
        }, 200);
      });
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
    const interval = window.setInterval(() => {
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
      !shouldPollProcessingStatus(selectedNote.processingStatus)
    ) {
      return;
    }
    const noteId = selectedNote.id;
    const startedAt = performance.now();
    // Drops in-flight responses once this effect is torn down (note switched,
    // status moved on, note deleted) so a late resolution can't apply a stale
    // snapshot — or surface a spurious "note not found" error after a delete.
    let cancelled = false;
    const interval = window.setInterval(() => {
      getNote(noteId)
        .then((note) => {
          if (cancelled) return;
          if (
            import.meta.env.DEV &&
            !shouldPollProcessingStatus(note.processingStatus)
          ) {
            console.debug("[processing] polling complete", {
              noteId,
              status: note.processingStatus,
              durationMs: Math.round(performance.now() - startedAt),
            });
          }
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
      if (!isCreateNoteShortcut(event)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void handleCreateNote(null);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCreateNote]);

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
      // Deleting a folder strips its association from any notes but
      // never deletes the notes themselves — they stay in your library.
      await deleteFolder(folderId, false);
      dispatch({ type: "folderDeleted", folderId });
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

  const handleStartRecording = useCallback(async () => {
    if (!selectedNoteId) return;
    recordingNoteIdRef.current = selectedNoteId;
    dispatch({
      type: "recordingStatusChanged",
      status: startingRecordingStatus(sourceMode),
    });
    try {
      setCheckingSourceReadiness(true);
      const readiness = await checkRecordingSourceReadiness(sourceMode);
      setSourceReadiness(readiness);

      const micSource = readiness.sources.find(
        (source) => source.source === "microphone",
      );
      if (!micSource?.ready) {
        dispatch({ type: "recordingStatusCleared" });
        setError(micSource?.message ?? "Microphone is not ready.");
        return;
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

      const recording = await startRecording(selectedNoteId, effectiveMode);
      dispatch({
        type: "recordingStatusChanged",
        status: recordingToStatus(recording),
      });
      playRecordingSound("start");
    } catch (err) {
      dispatch({ type: "recordingStatusCleared" });
      setError(messageFromError(err));
    } finally {
      setCheckingSourceReadiness(false);
    }
  }, [selectedNoteId, sourceMode]);

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen(MEETING_START_TRANSCRIPTION_EVENT, () => {
      if (appBlocked || !bootstrapped) return;
      setActiveView("meetings");
      void handleStartRecording();
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [appBlocked, bootstrapped, handleStartRecording]);

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
    dispatch({ type: "recordingStatusCleared" });
    playRecordingSound("stop");
    // Optimistically flip the note that owns this recording to transcribing.
    // The selected note isn't necessarily that note — the user may have
    // browsed elsewhere while recording — and stamping the wrong note as
    // transcribing would lock its record button and shimmer forever.
    if (selectedNote && selectedNote.id === recordingNoteIdRef.current) {
      dispatch({
        type: "noteProcessingUpdated",
        note: { ...selectedNote, processingStatus: "transcribing" },
      });
    }
    try {
      const result = await finishRecording(sessionId);
      dispatch({ type: "noteProcessingUpdated", note: result.note });
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      finishingSessionsRef.current.delete(sessionId);
    }
  }

  async function handlePauseRecording(sessionId: string) {
    try {
      const status = await pauseRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
      playRecordingSound("pause");
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleResumeRecording(sessionId: string) {
    playRecordingSound("start");
    try {
      const status = await resumeRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

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

  return (
    <main
      className="app-shell"
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
      data-sidebar-resizing={sidebarResizing ? "true" : "false"}
      data-sidebar-transition={sidebarTransition}
      style={
        {
          "--sidebar-w-current": `${sidebarWidth}px`,
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
          if (view === "settings" && activeView !== "settings") {
            setSettingsReturnView(activeView);
          }
          setActiveView(view);
          if (view !== "agent") {
            setActiveAgentSession(undefined);
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
        onSelectNote={(noteId) => void handleSelectNote(noteId)}
        onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
        onOpenMoveDialog={(noteId) => setMoveDialogNoteId(noteId)}
        onRemoveNoteFromFolder={(noteId, folderId) =>
          void handleRemoveNoteFromFolder(noteId, folderId)
        }
        onNewAgentSession={() => {
          setActiveAgentSession(undefined);
          setActiveView("agent");
        }}
        onSelectAgentSession={(session) => {
          setActiveAgentSession(session);
          setActiveView("agent");
        }}
        recoverableNoteIds={recoverableNoteIds}
        collapsed={sidebarCollapsed}
      />
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(event) =>
          handleSidebarResizeStart(
            event,
            sidebarWidth,
            () => {
              setSidebarResizing(true);
              setSidebarTransition("none");
            },
            (finalWidth) => {
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
          )
        }
      />
      <section className="main-panel">
        {accessibilityBlocked ? <PermissionBanner /> : null}
        <div className="main-panel-body" data-active-view={activeView}>
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
              />
            ) : activeView === "dictation" ? (
              <DictationHistoryView
                onNavigateToSettings={(target) => {
                  setSettingsReturnView(activeView);
                  setActiveView("settings");
                  setSettingsTab("dictation");
                  const headingId =
                    target === "style" ? "style-heading" : "dictionary-heading";
                  window.setTimeout(() => {
                    document
                      .getElementById(headingId)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }, 80);
                }}
              />
            ) : activeView === "agent" ? (
              <AgentWorkspace
                initialSession={activeAgentSession}
                pendingReply={pendingAgentReply}
              />
            ) : activeView === "notes" || activeView === "all-notes" ? (
              <NotesList
                notes={state.notes}
                selectedNoteId={state.selectedNoteId}
                onSelectNote={(noteId) =>
                  void handleSelectNoteFromAllNotes(noteId)
                }
                onCreateNote={() => void handleCreateNote(null)}
                onOpenMoveDialog={(noteId) => setMoveDialogNoteId(noteId)}
                onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
              />
            ) : activeView === "folders" ? (
              <FoldersWorkspace
                folders={state.folders}
                notes={state.notes}
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
                onOpenMoveDialog={(noteId) => setMoveDialogNoteId(noteId)}
                onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
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
                      { label: selectedNote.title.trim() || "New note" },
                    ]}
                  />
                ) : originAllNotes ? (
                  <BreadcrumbBar
                    backLabel="Back to Notes"
                    onBack={() => {
                      setActiveView("all-notes");
                      setOriginAllNotes(false);
                    }}
                    items={[
                      {
                        label: "Notes",
                        onClick: () => {
                          setActiveView("all-notes");
                          setOriginAllNotes(false);
                        },
                      },
                      { label: selectedNote.title.trim() || "New note" },
                    ]}
                  />
                ) : null}
                <NoteEditor
                  note={selectedNote}
                  folders={state.folders}
                  recordingStatus={state.recordingStatus}
                  sourceMode={sourceMode}
                  sourceReadiness={sourceReadiness}
                  recovery={selectedRecovery}
                  onRecoverRecording={(sessionId) =>
                    handleRecovery(sessionId, "validate")
                  }
                  onDiscardRecording={(sessionId) =>
                    handleRecovery(sessionId, "discard")
                  }
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
                  onTabChange={(activeTab) =>
                    void updateNote({
                      noteId: selectedNote.id,
                      activeTab,
                    }).then((note) => dispatch({ type: "noteUpdated", note }))
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
                      // Surface the failure (the banner only releases its
                      // busy gate on rejection — it expects us to report).
                      setError(messageFromError(err));
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
            ) : (
              <section className="editor-empty" aria-label="Opening note" />
            )}
          </div>
        </div>
      </section>
      <MoveNoteToFolderDialog
        open={moveDialogNoteId !== null}
        onClose={() => setMoveDialogNoteId(null)}
        note={
          moveDialogNoteId
            ? (state.notes.find((n) => n.id === moveDialogNoteId) ?? null)
            : null
        }
        folders={state.folders}
        onSetFolder={(noteId, folderId) =>
          handleSetNoteFolder(noteId, folderId)
        }
      />
      <UpdateDialog
        payload={pendingUpdate}
        status={updateStatus}
        installing={installingUpdate}
        progress={updateProgress}
        onClose={() => {
          if (installingUpdate) return;
          setPendingUpdate(null);
          setUpdateStatus(null);
          setUpdateProgress(null);
        }}
        onInstall={() => {
          if (!pendingUpdate || installingUpdate) return;
          setInstallingUpdate(true);
          setUpdateStatus(null);
          void installScribeUpdate({
            update: pendingUpdate.update,
            relaunch: relaunchScribe,
            reportProgress: setUpdateProgress,
            reportFailure: (message) => {
              setInstallingUpdate(false);
              setUpdateProgress(null);
              setUpdateStatus(`Update failed: ${message}`);
            },
          });
        }}
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

function UpdateDialog({
  payload,
  status,
  installing,
  progress,
  onClose,
  onInstall,
}: {
  payload: UpdatePromptPayload<ScribeUpdate> | null;
  status: string | null;
  installing: boolean;
  progress: UpdateInstallProgress | null;
  onClose: () => void;
  onInstall: () => void;
}) {
  const percent =
    progress?.contentLength && progress.contentLength > 0
      ? Math.min(
          100,
          Math.round(
            ((progress.downloadedBytes ?? 0) / progress.contentLength) * 100,
          ),
        )
      : undefined;

  return (
    <Dialog
      open={!!payload || !!status}
      onClose={onClose}
      title={payload ? `OS June ${payload.version}` : "Software update"}
      description={
        payload
          ? "A new version is available."
          : (status ?? "Checking for updates...")
      }
      width={460}
      disableBackdropClose={installing}
      footer={
        payload ? (
          <>
            <button
              type="button"
              className="primary-action"
              disabled={installing}
              onClick={onClose}
            >
              Later
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={installing}
              onClick={onInstall}
            >
              {installing ? "Installing..." : "Install & relaunch"}
            </button>
          </>
        ) : (
          <button type="button" className="primary-action" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {payload ? (
        <div className="update-dialog-body">
          {payload.notes ? (
            <div className="update-release-notes">{payload.notes}</div>
          ) : (
            <p className="dialog-field-hint">No release notes were provided.</p>
          )}
          {progress ? (
            <div className="update-progress" aria-live="polite">
              <div className="update-progress-row">
                <span>
                  {progress.state === "installing"
                    ? "Installing update..."
                    : "Downloading update..."}
                </span>
                {percent !== undefined ? <span>{percent}%</span> : null}
              </div>
              <div className="update-progress-track">
                <div
                  className="update-progress-fill"
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
            </div>
          ) : null}
          {status ? <p className="dialog-field-hint">{status}</p> : null}
        </div>
      ) : (
        <div />
      )}
    </Dialog>
  );
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

function handleSidebarResizeStart(
  event: ReactPointerEvent<HTMLDivElement>,
  currentWidth: number,
  onStart: () => void,
  onEnd: (width: number) => void,
) {
  if (event.button !== 0) return;
  event.preventDefault();
  onStart();
  const handle = event.currentTarget;
  const shell = handle.closest(".app-shell") as HTMLElement | null;
  const mainPanel = shell?.querySelector(".main-panel") as HTMLElement | null;
  const startX = event.clientX;
  const startWidth = currentWidth;
  let latestWidth = currentWidth;
  let collapsed = currentWidth === 0;

  // While dragging in the resizable range the panel tracks the cursor with no
  // transition (snappy). But the snap between the min width and fully-closed
  // is a discrete jump — animate *that* crossing so collapsing/reopening via
  // drag tweens smoothly. The handle's `left` rides along so the drag line
  // doesn't detach from the panel edge mid-tween, and the main panel's left
  // margin eases to its collapsed gutter at the same time so the card lands on
  // its padding instead of sliding to the window edge and snapping back.
  function setSnapTransition(animate: boolean) {
    const timing = "var(--t-med) var(--ease-out)";
    if (shell)
      shell.style.transition = animate
        ? `grid-template-columns ${timing}`
        : "none";
    handle.style.transition = animate ? `left ${timing}` : "none";
    if (mainPanel)
      mainPanel.style.transition = animate ? `margin ${timing}` : "none";
  }

  function applyWidth(width: number) {
    shell?.style.setProperty("--sidebar-w-current", `${width}px`);
    // Expanded the card hugs grid column 2 (the sidebar supplies the gutter);
    // collapsed it must carry its own left gutter. Drive it here so it tweens
    // with the collapse rather than jumping when React commits on pointer-up.
    // `--main-gutter` keeps the resize bar tracking the card's left edge (so it
    // rides the white, not the gray) since the bar is positioned off it too.
    if (mainPanel)
      mainPanel.style.marginLeft = width === 0 ? "var(--sp-3)" : "0px";
    shell?.style.setProperty(
      "--main-gutter",
      width === 0 ? "var(--sp-3)" : "0px",
    );
    latestWidth = width;
  }

  function onPointerMove(moveEvent: PointerEvent) {
    const rawWidth = startWidth + moveEvent.clientX - startX;

    if (rawWidth <= SIDEBAR_COLLAPSE_WIDTH) {
      // Below the threshold: collapse to 0. Only kick the smooth transition on
      // the *crossing* — subsequent moves must leave it alone so the tween
      // isn't cancelled by the next pointermove a few ms later.
      if (!collapsed) {
        collapsed = true;
        setSnapTransition(true);
        applyWidth(0);
      }
      return;
    }

    const nextWidth = Math.min(
      sidebarMaxWidth(),
      Math.max(SIDEBAR_MIN_WIDTH, rawWidth),
    );
    if (collapsed) {
      // Re-opening from collapsed: animate the 0 → min snap.
      collapsed = false;
      setSnapTransition(true);
      applyWidth(nextWidth);
      return;
    }
    // Live resize within range: snap-follow the cursor, but don't re-assert
    // `none` (which would cancel an in-flight open tween) unless the width
    // actually moves.
    if (nextWidth !== latestWidth) {
      setSnapTransition(false);
      applyWidth(nextWidth);
    }
  }

  function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // Hand control back to React-driven styling. Commit synchronously so the
    // collapsed/expanded class (and its matching left margin) is in the DOM
    // *before* we drop the inline margin — otherwise removing it would briefly
    // expose the expanded margin and flash a jump.
    shell?.style.removeProperty("transition");
    handle.style.removeProperty("transition");
    mainPanel?.style.removeProperty("transition");
    flushSync(() => onEnd(latestWidth));
    mainPanel?.style.removeProperty("margin-left");
    shell?.style.removeProperty("--main-gutter");
  }

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
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

function isCreateNoteShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "n" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

function stringPayloadValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function recordingToStatus(recording: {
  id: string;
  sourceMode?: RecordingStatusDto["sourceMode"];
  state: RecordingStatusDto["state"];
  elapsedMs: number;
  level: RecordingStatusDto["level"];
  sources?: RecordingStatusDto["sources"];
  warnings?: RecordingStatusDto["warnings"];
}): RecordingStatusDto {
  return {
    sessionId: recording.id,
    sourceMode: recording.sourceMode,
    state: recording.state,
    elapsedMs: recording.elapsedMs,
    level: recording.level,
    silenceWarning: false,
    bytesWritten: 0,
    sources: recording.sources,
    warnings: recording.warnings,
  };
}

function startingRecordingStatus(
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
    sourceMode,
    state: "starting",
    elapsedMs: 0,
    level: { peak: 0, rms: 0, recentPeaks: [] },
    silenceWarning: false,
    bytesWritten: 0,
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

function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function isAppErrorCode(err: unknown, code: string) {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    String((err as { code: unknown }).code) === code
  );
}
