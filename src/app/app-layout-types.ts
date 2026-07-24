import type { AgentSessionsListHandle } from "../components/agent/AgentSessionsList";
import type { ReportCategory } from "../components/agent/composer/reportCategory";
import type { NotesListHandle } from "../components/notes-list/NotesList";
import type { SettingsTab } from "../components/settings/settings-config";
import type { SidebarView } from "../components/sidebar/Sidebar";
import type { TabItem } from "../components/tabs/TabBar";
import type { TabNav } from "./tabs/tabs";
import type { ReferralNudgeMoment } from "../components/referral/ReferralNudge";
import type {
  FolderDto,
  NoteDto,
  RecordingStatusDto,
  AccountStatus,
  HermesSessionInfo,
} from "../lib/tauri";
import type { MaxUpgradeTransport } from "../lib/billing-actions";
import type { MaxGrantWait } from "../lib/max-upgrade";
import type { NoteChat } from "../components/note-chat/useNoteChat";
import type { JuneUpdate } from "../lib/updater";
import type {
  UpdateInstallProgress,
  UpdatePromptPayload,
  UpdateStatusDisplayState,
} from "./update-decision";
import type { RecordingInactivityPrompt } from "./app-shell";
import type { NotesAction, NotesState } from "./state/app-state";
import type * as React from "react";

export type RenderAppLayoutDependencies = {
  accessibilityBannerDismissed: boolean;
  accessibilityBlocked: boolean;
  account: AccountStatus;
  activateTab: (id: string) => void;
  activeTabId: string;
  activeView: SidebarView;
  agentSessions: HermesSessionInfo[];
  agentSessionsListRef: React.MutableRefObject<AgentSessionsListHandle | null>;
  appMaxGrantWaitRef: React.MutableRefObject<MaxGrantWait | undefined>;
  billingNotice: string | null;
  captureActive: boolean;
  dictationActive: boolean;
  changeSettingsTab: (tab: SettingsTab) => void;
  checkingUpdate: boolean;
  closeOtherTabs: (id: string) => void;
  closeTab: (id: string) => void;
  completedSessions: Record<string, string>;
  confirmDeleteNote: boolean;
  confirmMaxUpgrade: () => Promise<void>;
  detailScrollerActive: boolean;
  dispatch: React.Dispatch<NotesAction>;
  error: string | null;
  fundingAccount: AccountStatus;
  fundingRequired: boolean;
  handleCreateFolder: (name: string, description?: string) => Promise<FolderDto | undefined>;
  handleDeleteNote: (noteId: string) => Promise<void>;
  handleEnableAccessibility: () => void;
  handleKeepRecordingAfterInactivityPrompt: () => void;
  handleOpenNoteChatInAgent: (noteRef: { id: string; title: string }, sessionId?: string) => void;
  handleOpenRecordingNote: () => Promise<void>;
  handlePauseRecordingAfterInactivityPrompt: () => void;
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
  handleReorderTabs: (orderedVisibleIds: string[]) => void;
  handleReportIssue: (category?: ReportCategory) => void;
  handleSelectNote: (noteId: string) => Promise<void>;
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
  handleSignOut: () => Promise<void>;
  handleToggleSessionCompleted: (sessionId: string, completed: boolean) => Promise<void>;
  mainPanelBodyRef: React.MutableRefObject<HTMLDivElement | null>;
  maxUpgradeError: string | undefined;
  maxUpgradePrompt: {
    action: "upgrade_to_max";
    plan: "max";
    transport: MaxUpgradeTransport;
  } | null;
  moveDialogNoteIds: string[] | null;
  moveDialogSessionIds: string[] | null;
  noteChat: NoteChat;
  noteChatOpen: boolean;
  noteDetailScrollerActive: boolean;
  notesListRef: React.MutableRefObject<NotesListHandle | null>;
  openNewChatTab: () => void;
  openSettings: () => void;
  openTab: (nav: TabNav) => void;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    profile: string;
  } | null>;
  pillIsDemo: boolean;
  pillStatus: RecordingStatusDto | null;
  preparingUpdate: boolean;
  readyUpdate: UpdatePromptPayload<JuneUpdate> | null;
  recordingInactivityPrompt: RecordingInactivityPrompt | null;
  recordingInactivitySecondsRemaining: number;
  recordingNoteTitle: string;
  recoverableNoteIds: Set<string>;
  referralNudgeMoment: ReferralNudgeMoment | null;
  referralNudgeSourceRef: React.MutableRefObject<"trigger" | "demo">;
  refreshFundingAccount: () => Promise<AccountStatus | undefined>;
  relaunchingUpdate: boolean;
  selectedNote: NoteDto | undefined;
  sessionFolders: Record<string, string[]>;
  setAccessibilityBannerDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveAgentSession: (session: HermesSessionInfo | undefined) => void;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
  setConfirmDeleteNote: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setFolderReturnTarget: React.Dispatch<
    React.SetStateAction<{ noteId: string; label: string } | undefined>
  >;
  setMaxUpgradePrompt: React.Dispatch<
    React.SetStateAction<{
      action: "upgrade_to_max";
      plan: "max";
      transport: MaxUpgradeTransport;
    } | null>
  >;
  setMoveDialogNoteIds: React.Dispatch<React.SetStateAction<string[] | null>>;
  setMoveDialogSessionIds: React.Dispatch<React.SetStateAction<string[] | null>>;
  setNoteChatOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setNoteShareUrl: React.Dispatch<React.SetStateAction<string | null>>;
  setOriginAllNotes: React.Dispatch<React.SetStateAction<boolean>>;
  setOriginFolderId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setReferralNudgeMoment: React.Dispatch<React.SetStateAction<ReferralNudgeMoment | null>>;
  setShareNoteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarResizing: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarTransition: React.Dispatch<React.SetStateAction<"none" | "smooth">>;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  setUpdateProgress: React.Dispatch<React.SetStateAction<UpdateInstallProgress | null>>;
  setUpdateStatus: (status: string | null, failed?: boolean) => void;
  settingsDetailScrollerActive: boolean;
  settingsReturnView: SidebarView;
  settingsTab: SettingsTab;
  shareNoteOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarRecorderStatus: RecordingStatusDto | null;
  sidebarResizing: boolean;
  sidebarTransition: "none" | "smooth";
  sidebarWidth: number;
  state: NotesState;
  tabItems: TabItem[];
  takeNewTabIntent: () => boolean;
  updateProgress: UpdateInstallProgress | null;
  updateProgressHiddenRef: React.MutableRefObject<boolean>;
  updateStatus: string | null;
  updateStatusDisplay: UpdateStatusDisplayState;
  updateStatusLeaving: boolean;
  workspaceContent: JSX.Element;
};
