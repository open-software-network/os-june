import type { AgentSessionsListHandle } from "../components/agent/AgentSessionsList";
import type { ReportCategory } from "../components/agent/composer/reportCategory";
import type { NotesListHandle } from "../components/notes-list/NotesList";
import type { SettingsTab } from "../components/settings/settings-config";
import type { SidebarView } from "../components/sidebar/Sidebar";
import type { TabNav } from "./tabs/tabs";
import type { LiveTranscriptEventDto, RecoverableRecordingDto } from "../lib/tauri";
import type {
  AccountStatus,
  FolderDto,
  HermesSessionInfo,
  NoteDto,
  NoteEditablePatch,
} from "../lib/tauri";
import type { RecordingSourceMode, RecordingSourceReadinessDto } from "../lib/tauri";
import type { JuneUpdate } from "../lib/updater";
import type { UpdateCheckMode, UpdatePromptPayload } from "./update-decision";
import type { NotesAction, NotesState } from "./state/app-state";
import type * as React from "react";

export type RenderAppWorkspaceDependencies = {
  accessibilityStatus: string | undefined;
  account: AccountStatus;
  accountLoading: boolean;
  activeAgentSessionFolder: FolderDto | undefined;
  activeAgentSessionId: string | undefined;
  activeAgentSessionSeed: HermesSessionInfo | undefined;
  activeView: SidebarView;
  agentOrigin: { kind: "project"; folderId: string } | { kind: "routines" } | undefined;
  agentOriginFolder: FolderDto | undefined;
  agentProjectContextFolder: FolderDto | undefined;
  agentSessions: HermesSessionInfo[];
  agentSessionsListRef: React.MutableRefObject<AgentSessionsListHandle | null>;
  agentWaitingSessionIds: ReadonlySet<string>;
  agentWorkingSessionIds: ReadonlySet<string>;
  changeSettingsTab: (tab: SettingsTab) => void;
  checkingSourceReadiness: boolean;
  completedSessions: Record<string, string>;
  dispatch: React.Dispatch<NotesAction>;
  folderReturnTarget: { noteId: string; label: string } | undefined;
  fundingAccount: AccountStatus;
  fundingRequired: boolean;
  handleAccountChanged: (nextAccount: AccountStatus) => void;
  handleCreateFolder: (name: string, description?: string) => Promise<FolderDto | undefined>;
  handleCreateNote: (folderId?: string | null) => Promise<void>;
  handleDeleteFolder: (folderId: string) => Promise<void>;
  handleDeleteNote: (noteId: string) => Promise<void>;
  handleDeleteNotes: (noteIds: string[]) => Promise<void>;
  handleEnableAccessibility: () => void;
  handleEnableMicrophone: () => void;
  handleEnableSystemAudio: () => void;
  handleFinishRecording: (sessionId: string, options?: { rethrow?: boolean }) => Promise<void>;
  handleKeepRecordingAfterMeetingEnd: (sessionId: string) => void;
  handleFlushNote: (noteId: string) => Promise<void>;
  handleFoldersImported: (folders: FolderDto[]) => void;
  handleNewAgentSession: () => void;
  handleNewAgentSessionInProject: (folderId: string) => void;
  handleOpenSessionProject: (folderId: string) => void;
  handlePauseRecording: (sessionId: string) => Promise<boolean>;
  handleReconcileToStable: () => void;
  handleRecovery: (sessionId: string, action: "validate" | "discard") => void;
  handleRelaunchUpdate: () => void;
  handleRemoveNoteFromFolder: (
    noteId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) => Promise<void>;
  handleRemoveSessionFromFolder: (
    sessionId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) => Promise<void>;
  handleRenameAgentSession: (sessionId: string, title: string) => void;
  handleRenameFolder: (folderId: string, name: string, description?: string) => Promise<void>;
  handleReportIssue: (category?: ReportCategory) => void;
  handleResumeRecording: (sessionId: string) => Promise<void>;
  handleSaveNoteNow: (noteId: string, patch: NoteEditablePatch) => Promise<void>;
  handleReturnToAgentOriginFolder: () => void;
  handleReturnToAgentsList: () => void;
  handleReturnToNote: (noteId: string) => Promise<void>;
  handleReturnToRoutines: () => void;
  handleSelectFolder: (folderId?: string) => void;
  handleSelectNote: (noteId: string) => Promise<void>;
  handleSelectNoteFromAllNotes: (noteId: string) => Promise<void>;
  handleSelectNoteFromFolder: (noteId: string, folderId: string) => Promise<void>;
  handleSetNoteFolder: (
    noteId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) => Promise<void>;
  handleSetSessionFolder: (
    sessionId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) => Promise<void>;
  handleSourceModeChange: (next: RecordingSourceMode) => void;
  handleStartBundleChat: (prompt: string) => void;
  handleStartRecording: () => Promise<void>;
  handleStopNowAfterMeetingEnd: (sessionId: string) => void;
  handleToggleSessionCompleted: (sessionId: string, completed: boolean) => Promise<void>;
  handleTopUp: () => void;
  handleUpdateNote: (noteId: string, patch: NoteEditablePatch) => void;
  memoryFolderFilter: string | undefined;
  meetingEndCountdown: { sessionId: string; secondsRemaining: number } | null;
  microphoneBlocked: boolean;
  microphoneStatus: string | undefined;
  noteDetailScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  noteShareUrl: string | null;
  noteToolbarActions: JSX.Element | null;
  notesListRef: React.MutableRefObject<NotesListHandle | null>;
  openMemorySettings: (folderId?: string) => void;
  openTab: (nav: TabNav) => void;
  originAllNotes: boolean;
  originFolder: FolderDto | undefined;
  readyUpdate: UpdatePromptPayload<JuneUpdate> | null;
  recordNoticesConsentPinned: boolean;
  recordingNoteId: string | undefined;
  refreshAccount: () => Promise<AccountStatus | undefined>;
  refreshFundingAccount: () => Promise<AccountStatus | undefined>;
  runUpdateCheck: (mode: UpdateCheckMode, check?: () => Promise<JuneUpdate | null>) => void;
  selectedNote: NoteDto | undefined;
  selectedNoteId: string | undefined;
  selectedNoteLiveTranscript: LiveTranscriptEventDto[];
  selectedRecovery: RecoverableRecordingDto | undefined;
  sessionFolders: Record<string, string[]>;
  setActiveAgentSession: (session: HermesSessionInfo | undefined) => void;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setFolderReturnTarget: React.Dispatch<
    React.SetStateAction<{ noteId: string; label: string } | undefined>
  >;
  setMoveDialogNoteIds: React.Dispatch<React.SetStateAction<string[] | null>>;
  setMoveDialogSessionIds: React.Dispatch<React.SetStateAction<string[] | null>>;
  setOriginAllNotes: React.Dispatch<React.SetStateAction<boolean>>;
  setOriginFolderId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSettingsDetailPinned: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsReturnView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setSettingsTab: React.Dispatch<React.SetStateAction<SettingsTab>>;
  settingsTab: SettingsTab;
  sourceMode: RecordingSourceMode;
  sourceReadiness: RecordingSourceReadinessDto | undefined;
  state: NotesState;
  takeNewTabIntent: () => boolean;
  topUpLabel: "Top up credits" | "Upgrade to Max" | "Upgrade";
};
