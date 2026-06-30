import { convertFileSrc, invoke } from "@tauri-apps/api/core";

// Re-exported so modules that build their own command calls (e.g. the Hermes
// admin Rust transport) route through the same `invoke` the rest of the app's
// bindings use, rather than reaching into `@tauri-apps/api/core` directly.
export { invoke };

export type ProcessingStatus =
  | "draft"
  | "recording"
  | "validating"
  | "transcribing"
  | "generating"
  | "ready"
  | "failed"
  | "recoverable";

export type FolderDto = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

/** Which project (folder) an agent session is filed under. Sessions live in
 * Hermes, so only the assignment is stored locally. */
export type SessionFolderDto = {
  sessionId: string;
  folderId: string;
};

export type DictionaryEntryDto = {
  id: string;
  phrase: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteListItemDto = {
  id: string;
  title: string;
  preview: string;
  processingStatus: ProcessingStatus;
  folderIds: string[];
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
};

export type TranscriptDto = {
  id: string;
  text: string;
  sourceMode?: RecordingSourceMode;
  source?: RecordingSource;
  startMs?: number;
  endMs?: number;
  turnIndex?: number;
  language?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  lastError?: string;
};

export const LIVE_TRANSCRIPT_EVENT = "live-transcript-event";

export type LiveTranscriptEventDto = {
  noteId: string;
  sessionId: string;
  sourceMode: RecordingSourceMode;
  source: RecordingSource;
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string;
  stability: "partial" | "final";
};

export type AudioLevelDto = {
  peak: number;
  rms: number;
  recentPeaks: number[];
};

export type RecordingState =
  | "idle"
  | "permissionDenied"
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "validating"
  | "partiallyValid"
  | "invalid"
  | "ready"
  | "failed"
  | "recoverable";

export type RecordingSourceMode = "microphoneOnly" | "microphonePlusSystem";
export type RecordingSource = "microphone" | "system";

export type DictationShortcutModifiers = {
  command: boolean;
  control: boolean;
  option: boolean;
  shift: boolean;
  function: boolean;
};

export type DictationShortcutSetting = {
  keyCode?: number;
  code: string;
  modifiers: DictationShortcutModifiers;
  label: string;
  pressCount: 1 | 2;
};

export type DictationShortcutKind = "push_to_talk" | "toggle";

export type DictationMicrophoneSetting = {
  id?: string;
  name?: string;
};

export type DictationStyle = "standard" | "casualLowercase" | "formal";

export type DictationSettingsDto = {
  pushToTalkShortcut: DictationShortcutSetting;
  toggleShortcut: DictationShortcutSetting;
  microphone: DictationMicrophoneSetting;
  style: DictationStyle;
  language?: string;
};

export type DictationSettingsResponse = {
  settings: DictationSettingsDto;
};

export type DictationHistoryItemDto = {
  id: string;
  text: string;
  language?: string;
  provider: string;
  createdAt: string;
};

export type ListDictationHistoryResponse = {
  items: DictationHistoryItemDto[];
  retentionDays: number;
};

export type DictationMicrophoneDeviceDto = {
  id: string;
  name: string;
};

export type DictationHelperEvent = {
  type: string;
  payload?: {
    devices?: DictationMicrophoneDeviceDto[];
    defaultDevice?: DictationMicrophoneDeviceDto;
    selectedID?: string;
    shortcut?: DictationShortcutSetting;
    message?: string;
    code?: string;
    path?: string;
    durationMs?: number | string;
    observedAudioLevel?: number | string;
    level?: number | string;
    [key: string]: unknown;
  };
};

export type ProviderModelMode = "transcription" | "generation";

export type ProviderModelSettingsDto = {
  transcriptionProvider: string;
  transcriptionModel: string;
  generationModel: string;
};

export type ProviderModelSettingsResponse = {
  settings: ProviderModelSettingsDto;
};

export type VeniceModelDto = {
  provider: string;
  id: string;
  name: string;
  modelType: string;
  description?: string;
  privacy?: string;
  pricing?: unknown;
  contextTokens?: number;
  traits: string[];
  capabilities: string[];
  priceUnit?: string;
  priceDescription?: string;
  creditsPerMillionSeconds?: number;
  inputCreditsPerMillionTokens?: number;
  outputCreditsPerMillionTokens?: number;
};

export type VeniceModelsResponse = {
  mode: ProviderModelMode;
  modelType: string;
  selectedModel: string;
  models: VeniceModelDto[];
};

export type SourceState =
  | "pending"
  | "permissionDenied"
  | "unavailable"
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "finalized"
  | "valid"
  | "invalid"
  | "recoverable"
  | "failed";

export type SourceStatusDto = {
  source: RecordingSource;
  state: SourceState;
  elapsedMs: number;
  bytesWritten: number;
  level: AudioLevelDto;
  silenceWarning: boolean;
  pathFinalized: boolean;
  lastError?: string;
};

export type SourceWarningDto = {
  source: RecordingSource;
  code: string;
  message: string;
};

export type RecordingStatusDto = {
  sessionId: string;
  noteId?: string;
  sourceMode?: RecordingSourceMode;
  state: RecordingState;
  elapsedMs: number;
  level: AudioLevelDto;
  silenceWarning: boolean;
  bytesWritten: number;
  livePreviewEnabled?: boolean;
  sources?: SourceStatusDto[];
  warnings?: SourceWarningDto[];
};

export type RecordingPresenceBoundsDto = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RecordingSessionDto = {
  id: string;
  noteId: string;
  sourceMode?: RecordingSourceMode;
  state: RecordingState;
  startedAt: string;
  elapsedMs: number;
  deviceLabel?: string;
  level: AudioLevelDto;
  livePreviewEnabled?: boolean;
  sources?: SourceStatusDto[];
  warnings?: SourceWarningDto[];
};

export type AudioArtifactDto = {
  id: string;
  source?: RecordingSource;
  format: "wav";
  durationMs: number;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
};

export type NoteDto = NoteListItemDto & {
  generatedContent?: string;
  editedContent?: string;
  transcript?: TranscriptDto;
  sourceTranscripts?: TranscriptDto[];
  recording?: RecordingSessionDto;
  audio?: AudioArtifactDto;
  audioSources?: AudioArtifactDto[];
  activeTab?: "notes" | "transcription";
  lastError?: string;
  /** Recordings queued behind the one currently processing (0 when none). */
  queuedRecordings?: number;
};

export type RecoverableRecordingDto = {
  sessionId: string;
  noteId: string;
  sourceMode?: RecordingSourceMode;
  startedAt: string;
  partialPathPresent: boolean;
  finalPathPresent: boolean;
  bytesFound: number;
  sources?: RecoverableSourceDto[];
};

export type RecoverableSourceDto = {
  source: RecordingSource;
  partialPathPresent: boolean;
  finalPathPresent: boolean;
  bytesFound: number;
  lastError?: string;
};

export type AgentSafetyProfile = "autonomousPrivate";

export type AgentTaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "waitingForUser"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentMessageRole = "system" | "assistant" | "user";

export type AgentToolEventStatus =
  | "proposed"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export type AgentMessageDto = {
  id: string;
  taskId: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
};

export type AgentToolEventDto = {
  id: string;
  taskId: string;
  toolName: string;
  status: AgentToolEventStatus;
  summary: string;
  argumentsJson?: string;
  resultJson?: string;
  redacted: boolean;
  createdAt: string;
  completedAt?: string;
};

export type AgentTaskDto = {
  id: string;
  title: string;
  prompt: string;
  status: AgentTaskStatus;
  safetyProfile: AgentSafetyProfile;
  hermesSessionId?: string;
  progressSummary?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  messages: AgentMessageDto[];
  toolEvents: AgentToolEventDto[];
};

export type AgentTaskListResponse = {
  items: AgentTaskDto[];
};

export type SuggestAgentSessionTitleResponse = {
  title: string;
};

export type HermesBridgeConnection = {
  baseUrl: string;
  wsUrl: string;
  token: string;
  port: number;
  command: string;
  hermesHome: string;
  cwd?: string | null;
  providerProxyPort: number;
  pid: number;
  /** True when the runtime is wrapped in the macOS Seatbelt write-jail (false
   * on non-macOS, when sandbox-exec is missing, or when disabled via the
   * escape-hatch env var). Mirrors the Rust connection field. */
  sandboxed: boolean;
  /** True when the user opted this runtime into Full mode (sandbox
   * deliberately off). Distinct from `sandboxed`, which can also be false for
   * environmental reasons. Mirrors the Rust connection field. */
  fullMode: boolean;
};

export type HermesBridgeStatus = {
  /** True when any runtime process is up. */
  running: boolean;
  /** Primary connection (the requested mode for a start call, otherwise
   * sandboxed-first). Mode-aware callers should use `connections`. */
  connection?: HermesBridgeConnection;
  /** Every live runtime process — at most one per write-access mode. */
  connections?: HermesBridgeConnection[];
  message?: string;
};

export type HermesFilesystemEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | string;
  size?: number | null;
  modifiedAt?: string | null;
  children?: HermesFilesystemEntry[] | null;
};

export type HermesFilesystemRoot = {
  id: string;
  label: string;
  path: string;
  description: string;
  entries: HermesFilesystemEntry[];
};

export type HermesFilesystemSnapshot = {
  roots: HermesFilesystemRoot[];
};

export type ImportedHermesFile = {
  name: string;
  path: string;
  rootLabel: string;
  size: number;
  previewDataUrl?: string | null;
};

export type HermesSkillInfo = {
  name: string;
  description?: string;
  category?: string;
  enabled?: boolean;
};

export type HermesSkillDocument = {
  name: string;
  relativePath: string;
  content: string;
  /** True for skills loaded from an external dir (e.g. ~/.agents/skills).
   *  June can read but not write them, so the editor is read-only. */
  readOnly?: boolean;
};

export type HermesToolsetInfo = {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  available?: boolean;
  tools?: string[];
  provider?: string;
};

export type HermesMessagingEnvVarInfo = {
  key: string;
  prompt?: string;
  description?: string;
  required?: boolean;
  advanced?: boolean;
  isSet?: boolean;
  is_set?: boolean;
  isPassword?: boolean;
  is_password?: boolean;
  redactedValue?: string | null;
  redacted_value?: string | null;
  url?: string | null;
};

export type HermesMessagingPlatformInfo = {
  id: string;
  name: string;
  description?: string;
  docsUrl?: string;
  docs_url?: string;
  enabled?: boolean;
  configured?: boolean;
  gatewayRunning?: boolean;
  gateway_running?: boolean;
  state?: string | null;
  errorCode?: string | null;
  error_code?: string | null;
  errorMessage?: string | null;
  error_message?: string | null;
  envVars?: HermesMessagingEnvVarInfo[];
  env_vars?: HermesMessagingEnvVarInfo[];
};

export type HermesMessagingPlatformsResponse = {
  platforms: HermesMessagingPlatformInfo[];
};

export type HermesSessionInfo = {
  id: string;
  active?: boolean;
  is_active?: boolean;
  status?: string;
  source?: string;
  kind?: string | null;
  session_type?: string | null;
  sessionType?: string | null;
  subagent_id?: string | null;
  subagentId?: string | null;
  user_id?: string;
  model?: string;
  title?: string;
  started_at?: string;
  startedAt?: string;
  ended_at?: string | null;
  endedAt?: string | null;
  end_reason?: string | null;
  message_count?: number;
  tool_call_count?: number;
  parent_session_id?: string | null;
  parentSessionId?: string | null;
  last_active?: string;
  lastActive?: string;
  preview?: string;
  has_system_prompt?: boolean;
  has_model_config?: boolean;
};

export type HermesSessionsResponse = {
  sessions?: HermesSessionInfo[];
  items?: HermesSessionInfo[];
  data?: HermesSessionInfo[];
  total?: number;
  limit?: number;
  offset?: number;
};

export type HermesSessionMessage = {
  id: string;
  session_id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  text?: unknown;
  context?: unknown;
  name?: string | null;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  tool_name?: string | null;
  timestamp?: string | number;
  created_at?: string | number;
  token_count?: number | null;
  finish_reason?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: unknown;
  codex_reasoning_items?: unknown;
  codex_message_items?: unknown;
};

export type HermesSessionMessagesResponse = {
  messages?: HermesSessionMessage[];
  items?: HermesSessionMessage[];
  data?: HermesSessionMessage[];
};

export type BootstrapResponse = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  activeRecoveries: RecoverableRecordingDto[];
  providerConfigured: boolean;
};

export type AudioValidationDto = {
  fileExists: boolean;
  nonZeroSize: boolean;
  readableAudio: boolean;
  expectedDurationMs: number;
  actualDurationMs: number;
  durationWithinTolerance: boolean;
  nonSilentSignal: boolean;
  peakAmplitude: number;
  rmsAmplitude: number;
  warnings: string[];
};

export type SourceValidationDto = {
  source: RecordingSource;
  fileExists: boolean;
  nonZeroSize: boolean;
  readableAudio: boolean;
  expectedDurationMs: number;
  actualDurationMs?: number;
  durationWithinTolerance: boolean;
  nonSilentSignal: boolean;
  peakAmplitude?: number;
  rmsAmplitude?: number;
  warnings: string[];
  error?: string;
};

export type FinishRecordingResponse = {
  note: NoteDto;
  recording: RecordingSessionDto;
  validation: AudioValidationDto;
  validations?: SourceValidationDto[];
  processingStarted: boolean;
  warnings?: SourceWarningDto[];
};

export type ListNotesResponse = {
  items: NoteListItemDto[];
  nextCursor?: string;
};

export type SourceReadinessDto = {
  source: RecordingSource;
  required: boolean;
  ready: boolean;
  permissionState:
    | "unknown"
    | "granted"
    | "denied"
    | "restricted"
    | "unsupported";
  deviceAvailable: boolean;
  captureAvailable: boolean;
  recoveryAction?:
    | "openMicrophoneSettings"
    | "openSystemAudioSettings"
    | "upgradeMacos"
    | "restartApp";
  message?: string;
};

export type RecordingSourceReadinessDto = {
  sourceMode: RecordingSourceMode;
  ready: boolean;
  checkedAt?: string;
  sources: SourceReadinessDto[];
};

export async function bootstrapApp() {
  return invoke<BootstrapResponse>("bootstrap_app");
}

/** Opens the june-api /verify page (attestation, routing, retention) in
 * the default browser. Routed through Rust because the webview drops
 * target="_blank" anchors. */
export async function juneOpenVerifyPage() {
  return invoke<void>("june_open_verify_page");
}

export async function createNote(folderId?: string) {
  return invoke<NoteDto>("create_note", { request: { folderId } });
}

export async function createFolder(name: string, description?: string) {
  return invoke<FolderDto>("create_folder", {
    request: { name, description },
  });
}

export async function deleteFolder(folderId: string, deleteNotes: boolean) {
  return invoke<void>("delete_folder", {
    request: { folderId, deleteNotes },
  });
}

export async function renameFolder(
  folderId: string,
  name: string,
  description?: string,
) {
  return invoke<FolderDto>("rename_folder", {
    request: { folderId, name, description },
  });
}

export async function listFolders() {
  return invoke<FolderDto[]>("list_folders");
}

export async function assignNoteToFolder(noteId: string, folderId: string) {
  return invoke<NoteDto>("assign_note_to_folder", {
    request: { noteId, folderId },
  });
}

export async function removeNoteFromFolder(noteId: string, folderId: string) {
  return invoke<NoteDto>("remove_note_from_folder", {
    request: { noteId, folderId },
  });
}

export async function listSessionFolders() {
  return invoke<SessionFolderDto[]>("list_session_folders");
}

export async function assignSessionToFolder(
  sessionId: string,
  folderId: string,
) {
  return invoke<void>("assign_session_to_folder", {
    request: { sessionId, folderId },
  });
}

export async function removeSessionFromFolder(
  sessionId: string,
  folderId: string,
) {
  return invoke<void>("remove_session_from_folder", {
    request: { sessionId, folderId },
  });
}

export async function listDictionaryEntries() {
  return invoke<DictionaryEntryDto[]>("list_dictionary_entries");
}

export async function createDictionaryEntry(input: { phrase: string }) {
  return invoke<DictionaryEntryDto>("create_dictionary_entry", {
    request: input,
  });
}

export async function updateDictionaryEntry(input: {
  entryId: string;
  phrase: string;
}) {
  return invoke<DictionaryEntryDto>("update_dictionary_entry", {
    request: input,
  });
}

export async function deleteDictionaryEntry(entryId: string) {
  return invoke<void>("delete_dictionary_entry", {
    request: { entryId },
  });
}

export async function listAgentTasks() {
  return invoke<AgentTaskListResponse>("list_agent_tasks");
}

export async function agentHudShow() {
  return invoke<void>("agent_hud_show");
}

export async function agentHudHide() {
  return invoke<void>("agent_hud_hide");
}

export async function agentHudSetLayout(input: {
  expanded: boolean;
  cardCount?: number;
  contextMenuOpen?: boolean;
}) {
  return invoke<void>("agent_hud_set_layout", { request: input });
}

export async function agentHudOpenAgent(session?: HermesSessionInfo) {
  return invoke<void>("agent_hud_open_agent", { session });
}

export async function createAgentTask(input: {
  prompt: string;
  title?: string;
  safetyProfile?: AgentSafetyProfile;
  runPlaceholder?: boolean;
}) {
  return invoke<AgentTaskDto>("create_agent_task", { request: input });
}

export async function getAgentTask(taskId: string) {
  return invoke<AgentTaskDto>("get_agent_task", { request: { taskId } });
}

export async function sendAgentMessage(input: {
  taskId: string;
  content: string;
  runPlaceholder?: boolean;
}) {
  return invoke<AgentTaskDto>("send_agent_message", { request: input });
}

export async function saveAgentAssistantMessage(input: {
  taskId: string;
  content: string;
}) {
  return invoke<AgentTaskDto>("save_agent_assistant_message", {
    request: input,
  });
}

export async function saveAgentHermesSession(input: {
  taskId: string;
  hermesSessionId: string;
}) {
  return invoke<AgentTaskDto>("save_agent_hermes_session", {
    request: input,
  });
}

export async function suggestAgentSessionTitle(prompt: string) {
  return invoke<SuggestAgentSessionTitleResponse>(
    "suggest_agent_session_title",
    {
      request: { prompt },
    },
  );
}

export type SubmitIssueReportRequest = {
  /** Which kind of report this is: "bug" | "feedback" | "feature". Drives the
   * team's triage and (server side) the no-charge waiver for the turn. */
  category?: string;
  /** The user's report as they typed it, before the investigation wrapper. */
  description: string;
  /** June's diagnostic assessment from the report session, when available. */
  agentDiagnosis?: string;
  attachmentNames: string[];
  /** Workspace paths of the attached files; their bytes are uploaded with
   * the report. */
  attachmentPaths: string[];
  sessionId?: string;
};

export type SubmitIssueReportResponse = {
  received: boolean;
};

export async function submitIssueReport(request: SubmitIssueReportRequest) {
  return invoke<SubmitIssueReportResponse>("submit_issue_report", { request });
}

export type ExplainAgentApprovalResponse = {
  explanation: string;
};

/** One-shot generation call that explains a pending approval request in
 * plain language — the agent runtime stays parked on the approval. */
export async function explainAgentApproval(input: {
  description: string;
  command?: string;
}) {
  return invoke<ExplainAgentApprovalResponse>("explain_agent_approval", {
    request: input,
  });
}

export async function cancelAgentTask(taskId: string) {
  return invoke<AgentTaskDto>("cancel_agent_task", { request: { taskId } });
}

export async function retryAgentTask(taskId: string) {
  return invoke<AgentTaskDto>("retry_agent_task", { request: { taskId } });
}

export async function listAgentToolEvents(taskId: string) {
  return invoke<AgentToolEventDto[]>("list_agent_tool_events", {
    request: { taskId },
  });
}

export async function hermesBridgeStatus() {
  return invoke<HermesBridgeStatus>("hermes_bridge_status");
}

export async function ensureHermesBridgeGateway() {
  return invoke<void>("ensure_hermes_bridge_gateway");
}

export async function hermesBridgeSkills() {
  return invoke<HermesSkillInfo[]>("hermes_bridge_skills");
}

export async function getHermesBridgeSkill(name: string) {
  return invoke<HermesSkillDocument>("get_hermes_bridge_skill", {
    request: { name },
  });
}

export async function updateHermesBridgeSkill(input: {
  name: string;
  content: string;
}) {
  return invoke<HermesSkillDocument>("update_hermes_bridge_skill", {
    request: input,
  });
}

export async function toggleHermesBridgeSkill(input: {
  name: string;
  enabled: boolean;
}) {
  return invoke<{ ok: boolean; name: string; enabled: boolean }>(
    "toggle_hermes_bridge_skill",
    { request: input },
  );
}

export async function hermesBridgeToolsets() {
  return invoke<HermesToolsetInfo[]>("hermes_bridge_toolsets");
}

export async function toggleHermesBridgeToolset(input: {
  name: string;
  enabled: boolean;
}) {
  return invoke<{ ok: boolean; name: string; enabled: boolean }>(
    "toggle_hermes_bridge_toolset",
    { request: input },
  );
}

export type AgentCliAccessStatus = {
  enabled: boolean;
};

/** Whether sandboxed sessions may write the state folders of installed
 * agent CLIs (Claude Code, Codex, Gemini, opencode). */
export async function hermesAgentCliAccess() {
  return invoke<AgentCliAccessStatus>("hermes_agent_cli_access");
}

/** Persists the Agent CLI access opt-in and retires the sandboxed runtime so
 * the next session spawns with matching sandbox grants. */
export async function setHermesAgentCliAccess(enabled: boolean) {
  return invoke<AgentCliAccessStatus>("set_hermes_agent_cli_access", {
    request: { enabled },
  });
}

export async function hermesBridgeMessagingPlatforms() {
  return invoke<HermesMessagingPlatformsResponse>(
    "hermes_bridge_messaging_platforms",
  );
}

export async function hermesBridgeFilesystemSnapshot() {
  return invoke<HermesFilesystemSnapshot>("hermes_bridge_filesystem_snapshot");
}

export async function downloadHermesBridgeFile(path: string) {
  return invoke<string>("download_hermes_bridge_file", { request: { path } });
}

export async function hermesBridgeFilePreview(path: string) {
  return invoke<string | null>("hermes_bridge_file_preview", {
    request: { path },
  });
}

// Null when the file can't be shown as text (too large or binary) — the
// caller falls back to a download affordance instead of erroring.
export async function hermesBridgeFileText(path: string) {
  return invoke<string | null>("hermes_bridge_file_text", {
    request: { path },
  });
}

export async function importHermesBridgeFile(path: string) {
  return invoke<ImportedHermesFile>("import_hermes_bridge_file", {
    request: { path },
  });
}

// DOM drops in WKWebView carry no filesystem path, so the file's contents go
// over as the raw invoke payload with the name in a header (URI-encoded:
// header values must be ASCII).
export async function importHermesBridgeFileBytes(
  name: string,
  bytes: Uint8Array,
) {
  return invoke<ImportedHermesFile>("import_hermes_bridge_file_bytes", bytes, {
    headers: { "x-file-name": encodeURIComponent(name) },
  });
}

export async function hermesBridgeSessions(
  input: {
    limit?: number;
    offset?: number;
    archived?: "exclude" | "include" | "only";
    minMessages?: number;
    order?: string;
    query?: string;
  } = {},
) {
  return invoke<HermesSessionsResponse>("hermes_bridge_sessions", {
    request: input,
  });
}

export async function hermesBridgeSessionMessages(sessionId: string) {
  return invoke<HermesSessionMessagesResponse>(
    "hermes_bridge_session_messages",
    { request: { sessionId } },
  );
}

export async function deleteHermesBridgeSession(sessionId: string) {
  return invoke<unknown>("delete_hermes_bridge_session", {
    request: { sessionId },
  });
}

export async function ensureHermesBridgeSession(input: {
  sessionId: string;
  title?: string;
  model?: string;
}) {
  return invoke<unknown>("ensure_hermes_bridge_session", {
    request: input,
  });
}

/** A raw cron job record from the bridge's dashboard API, as stored in
 * Hermes's jobs file — unlike the gateway's formatted view, `prompt` is the
 * full text and `schedule` is the parsed structure next to its display
 * string. Only the fields the app reads are typed. */
export type HermesCronJobRecord = {
  id: string;
  name: string;
  prompt: string;
  schedule?: { kind?: string } | null;
  schedule_display?: string | null;
  repeat?: { times?: number | null; completed?: number } | null;
  deliver?: string | null;
  enabled?: boolean;
  state?: string | null;
  paused_reason?: string | null;
  created_at?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: "ok" | "error" | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  enabled_toolsets?: string[] | null;
  script?: string | null;
  no_agent?: boolean;
};

export async function hermesBridgeCronJobs() {
  return invoke<HermesCronJobRecord[]>("hermes_bridge_cron_jobs");
}

export async function createHermesBridgeCronJob(input: {
  prompt: string;
  schedule: string;
  name?: string;
  deliver?: string;
}) {
  return invoke<HermesCronJobRecord>("create_hermes_bridge_cron_job", {
    request: input,
  });
}

export async function updateHermesBridgeCronJob(
  jobId: string,
  updates: Record<string, unknown>,
) {
  return invoke<HermesCronJobRecord>("update_hermes_bridge_cron_job", {
    request: { jobId, updates },
  });
}

export async function hermesBridgeCronJobAction(
  jobId: string,
  action: "pause" | "resume" | "trigger",
) {
  return invoke<HermesCronJobRecord>("hermes_bridge_cron_job_action", {
    request: { jobId, action },
  });
}

export async function deleteHermesBridgeCronJob(jobId: string) {
  return invoke<unknown>("delete_hermes_bridge_cron_job", {
    request: { jobId },
  });
}

export async function updateHermesBridgeMessagingPlatform(input: {
  platformId: string;
  enabled?: boolean;
  env?: Record<string, string>;
}) {
  return invoke<{ ok: boolean; platform: string }>(
    "update_hermes_bridge_messaging_platform",
    { request: input },
  );
}

/** `fullMode` is an explicit mode choice: passing it restarts a running
 * runtime whose mode differs (the sandbox is applied at spawn). Omit it to
 * reuse whatever is running — fresh starts are always sandboxed. */
export async function startHermesBridge(cwd?: string, fullMode?: boolean) {
  return invoke<HermesBridgeStatus>("start_hermes_bridge", {
    request: { cwd, fullMode },
  });
}

export async function stopHermesBridge() {
  return invoke<HermesBridgeStatus>("stop_hermes_bridge");
}

/** The redacted result of an MCP OAuth login attempt. The Rust bridge runs
 * `hermes mcp login <server>`, opens the authorization URL in the OS browser,
 * and waits for the CLI to finish. It NEVER returns a token: only whether the
 * login succeeded, an already-redacted status message, and the (token-free)
 * authorization URL so June can offer a manual "open in browser" fallback.
 * `timedOut` is true when the wait elapsed before the CLI completed (the browser
 * sign-in is still the user's to finish; June never blocks on it). */
export type HermesMcpOauthLoginResult = {
  ok: boolean;
  /** A safe, already-redacted status message, or null when the CLI said nothing
   * quotable. Never carries a token, bearer value, or auth code. */
  message: string | null;
  /** The authorization URL the CLI emitted (token-free), or null. */
  authUrl: string | null;
  /** True when the wait elapsed before the CLI reported a terminal state. */
  timedOut: boolean;
};

/**
 * Runs the MCP OAuth sign-in for one server through the Rust bridge:
 * `hermes mcp login <server>` against the chosen runtime's profile, opening the
 * authorization URL in the OS browser. `mode` selects the runtime explicitly
 * (sandboxed vs unrestricted) — Rust never falls back to the first connection.
 * The result is redacted in Rust and re-checked in the view layer; no token is
 * ever returned to the webview.
 */
export async function hermesMcpOauthLogin(input: {
  mode: "sandboxed" | "unrestricted";
  server: string;
  profile?: string;
}) {
  return invoke<HermesMcpOauthLoginResult>("hermes_mcp_oauth_login", {
    request: input,
  });
}

/** The redacted result of a bundled-skill reset. Carries no skill content and no
 * secret-shaped CLI output: only whether the CLI reported success, an already
 * redacted status message, and whether the bounded wait elapsed. */
export type HermesResetSkillResult = {
  ok: boolean;
  /** A safe, already-redacted status message, or null when the CLI said nothing
   * quotable. */
  message: string | null;
  /** True when the wait elapsed before the CLI reported a terminal state. */
  timedOut: boolean;
};

/**
 * Resets (or restores) a bundled skill to its shipped baseline through the Rust
 * bridge: `hermes skills reset <name> [--restore]` against the chosen runtime's
 * profile. The dashboard exposes no reset endpoint, so this is the narrow CLI
 * fallback. `mode` selects the runtime explicitly (sandboxed vs unrestricted) —
 * Rust never falls back to the first connection. The skill name is validated
 * argument-safe on both sides and passed as a discrete CLI argument (no shell).
 * The result is redacted in Rust; no skill content is returned to the webview.
 */
export async function hermesResetBundledSkill(input: {
  mode: "sandboxed" | "unrestricted";
  name: string;
  profile?: string;
  restore?: boolean;
}) {
  return invoke<HermesResetSkillResult>("hermes_reset_bundled_skill", {
    request: input,
  });
}

/** One configured custom GitHub skill tap, as parsed from `hermes skills tap
 * list` by the Rust bridge. Carries only a validated `owner/repo`, an optional
 * safe path, and a trust marker. Never a token. Mirrors the Rust `HermesSkillTap`
 * (camelCase). */
export type HermesSkillTapDto = {
  /** The tap repository as `owner/repo` (validated argument-safe). */
  repo: string;
  /** The path override inside the repo, when the tap declares one. */
  path?: string;
  /** True only when Hermes explicitly marks the tap trusted/verified. The UI
   * treats every other tap as community. */
  trusted: boolean;
};

/** The result of listing taps. `taps` is the parsed list; `message` is an
 * already-redacted status line when the CLI failed. */
export type HermesSkillTapListResult = {
  ok: boolean;
  taps: HermesSkillTapDto[];
  /** A safe, already-redacted status message, or null. Never carries a token. */
  message: string | null;
  /** True when the bounded wait elapsed before the CLI reported a result. */
  timedOut: boolean;
};

/** The redacted result of a tap add/remove. Carries no token: only whether the
 * CLI reported success, an already-redacted status message, and whether the
 * bounded wait elapsed. */
export type HermesSkillTapWriteResult = {
  ok: boolean;
  message: string | null;
  timedOut: boolean;
};

/**
 * Lists the configured custom GitHub skill taps for the chosen runtime/profile.
 * The dashboard (v2026.6.19) exposes no tap endpoints, so this runs the pinned
 * `hermes skills tap list` CLI through the Rust bridge. `mode` selects the
 * runtime explicitly (sandboxed vs unrestricted) with no first-connection
 * fallback. The output is parsed and redacted in Rust; no token is returned.
 */
export async function hermesSkillTapList(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
}) {
  return invoke<HermesSkillTapListResult>("hermes_skill_tap_list", {
    request: input,
  });
}

/**
 * Adds a custom GitHub skill tap (`owner/repo`, optional path override) through
 * the Rust bridge: `hermes skills tap add <owner/repo> [--path <path>]`. The repo
 * and path are validated argument-safe on both sides and passed as discrete CLI
 * arguments (no shell). `mode` selects the runtime explicitly. The result is
 * redacted in Rust; no token is returned.
 */
export async function hermesSkillTapAdd(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
  repo: string;
  path?: string;
}) {
  return invoke<HermesSkillTapWriteResult>("hermes_skill_tap_add", {
    request: input,
  });
}

/**
 * Removes a custom GitHub skill tap by `owner/repo` through the Rust bridge:
 * `hermes skills tap remove <owner/repo>`. The repo is validated argument-safe on
 * both sides and passed as a discrete CLI argument (no shell).
 */
export async function hermesSkillTapRemove(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
  repo: string;
}) {
  return invoke<HermesSkillTapWriteResult>("hermes_skill_tap_remove", {
    request: input,
  });
}

/** The read-only filesystem status of one configured external skill directory,
 * as reported by the June-side `hermes_inspect_external_dirs` command. Carries
 * both the raw configured path and the resolved one. Mirrors the Rust
 * `ExternalDirStatus` (camelCase). */
export type ExternalDirStatus = {
  /** The path exactly as configured (with `~`/`${VAR}` unexpanded). */
  rawPath: string;
  /** The expanded absolute path, or null when a variable could not be resolved. */
  resolvedPath: string | null;
  /** The name of an unresolved environment variable referenced in the path, or
   * null. Never the variable's value. */
  unresolvedVar: string | null;
  /** True when the resolved path exists. */
  exists: boolean;
  /** True when the resolved path exists and is a directory. */
  isDir: boolean;
  /** True when June could list the directory. */
  readable: boolean;
  /** True/false when writability was safely detected, null when ambiguous. */
  writable: boolean | null;
  /** Count of discovered skills, or null when missing/unreadable. */
  skillCount: number | null;
  /** Discovered skill names (for shadowing explanation). */
  skillNames: string[];
};

/**
 * Inspects the configured external skill directories read-only through June's
 * own (non-jailed) Rust process: expands `~`/`${VAR}`, stats each path, probes
 * readability/writability, and counts discovered skills. No mutation, no
 * file-content reads, no secrets returned. The CONFIG itself is written through
 * Hermes' `PUT /api/config` (so the jailed dashboard owns the config.yaml
 * write); this command only reports filesystem status the dashboard can't.
 */
export async function hermesInspectExternalDirs(dirs: string[]) {
  return invoke<ExternalDirStatus[]>("hermes_inspect_external_dirs", {
    request: { dirs },
  });
}

/** A Hermes skill bundle as June reads/writes it. `slug` is the file stem and
 * the slash command; `skills` is the ordered member list; `instructions` is the
 * optional prompt text Hermes prepends at invocation. Mirrors the Rust
 * `HermesSkillBundle`. */
export type HermesSkillBundleDto = {
  slug: string;
  name?: string;
  description?: string;
  skills: string[];
  instructions?: string;
};

/**
 * Lists the skill bundles for the chosen runtime/profile. The dashboard exposes
 * no bundle endpoints, so this reads the per-profile `skill-bundles` directory
 * through the Rust bridge. `mode` selects the runtime explicitly (sandboxed vs
 * unrestricted) with no first-connection fallback. Returns an empty list when no
 * bundles exist yet.
 */
export async function hermesListSkillBundles(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
}) {
  return invoke<HermesSkillBundleDto[]>("hermes_list_skill_bundles", {
    request: input,
  });
}

/**
 * Creates or updates a bundle by writing its YAML file. `previousSlug`, when it
 * differs from `bundle.slug`, removes the old file after the new one is written
 * (a rename). The slug is validated argument/path safe on both sides; the write
 * is confined to the bundles directory. Returns the saved bundle.
 */
export async function hermesSaveSkillBundle(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
  bundle: HermesSkillBundleDto;
  previousSlug?: string;
}) {
  return invoke<HermesSkillBundleDto>("hermes_save_skill_bundle", {
    request: input,
  });
}

/** Deletes a bundle's YAML file. The slug is validated and the path confined to
 * the bundles directory; a missing file is treated as success. */
export async function hermesDeleteSkillBundle(input: {
  mode: "sandboxed" | "unrestricted";
  profile?: string;
  slug: string;
}) {
  return invoke<void>("hermes_delete_skill_bundle", { request: input });
}
/** Developer-only: resume a June session in Hermes' own raw TUI in a Terminal
 * window. `unrestricted` mirrors the session's mode so the debug session runs
 * under the same Seatbelt jail June used. macOS only; rejects elsewhere. */
export async function openHermesTuiDebug(input: {
  sessionId: string;
  unrestricted: boolean;
}) {
  return invoke<void>("open_hermes_tui_debug", { request: input });
}

export async function listNotes(folderId?: string) {
  return invoke<ListNotesResponse>("list_notes", { request: { folderId } });
}

export async function getNote(noteId: string) {
  return invoke<NoteDto>("get_note", { request: { noteId } });
}

export async function deleteNote(noteId: string) {
  return invoke<void>("delete_note", { request: { noteId } });
}

export async function deleteNotes(noteIds: string[]) {
  return invoke<void>("delete_notes", { request: { noteIds } });
}

export async function updateNote(input: {
  noteId: string;
  title?: string;
  editedContent?: string;
  activeTab?: "notes" | "transcription";
}) {
  return invoke<NoteDto>("update_note", { request: input });
}

export async function checkRecordingSourceReadiness(
  sourceMode: RecordingSourceMode,
) {
  return invoke<RecordingSourceReadinessDto>(
    "check_recording_source_readiness",
    {
      request: { sourceMode },
    },
  );
}

export async function openPrivacySettings(
  pane: "microphone" | "accessibility" | "systemAudio",
) {
  return invoke<void>("open_privacy_settings", { request: { pane } });
}

export async function startRecording(
  noteId: string,
  sourceMode: RecordingSourceMode = "microphoneOnly",
) {
  return invoke<RecordingSessionDto>("start_recording", {
    request: { noteId, sourceMode },
  });
}

export async function pauseRecording(sessionId: string) {
  return invoke<RecordingStatusDto>("pause_recording", {
    request: { sessionId },
  });
}

export async function resumeRecording(sessionId: string) {
  return invoke<RecordingStatusDto>("resume_recording", {
    request: { sessionId },
  });
}

export async function getRecordingStatus(sessionId: string) {
  return invoke<RecordingStatusDto>("get_recording_status", {
    request: { sessionId },
  });
}

export async function setRecordingPresenceBounds(
  bounds: RecordingPresenceBoundsDto | null,
  ownerId: string,
) {
  return invoke<void>("set_recording_presence_bounds", {
    request: { bounds, ownerId },
  });
}

export async function finishRecording(sessionId: string) {
  return invoke<FinishRecordingResponse>("finish_recording", {
    request: { sessionId },
  });
}

export async function retryProcessing(noteId: string) {
  return invoke<NoteDto>("retry_processing", {
    request: { noteId, step: "all" },
  });
}

export async function recoverRecording(
  sessionId: string,
  action: "validate" | "discard",
) {
  return invoke<NoteDto>("recover_recording", {
    request: { sessionId, action },
  });
}

export type AccountUser = {
  id: string;
  handle: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
};

export type AccountBalance = {
  /** Present whenever the backend snapshot succeeds; optional so older
   * payload shapes (and test fixtures) without it don't lock the app. */
  credits?: number;
  /** Normalized usage remaining for the current plan or free allowance.
   * Optional while the app can still receive older accounts API payloads. */
  usageRemainingPercent?: number;
  usdMillis: number;
};

export type AccountSubscription = {
  subscribed: boolean;
  status?: "trialing" | "active" | "past_due" | "canceled" | (string & {});
  /** Monthly plan credits returned by OS Accounts. Used as a fallback for
   * deployments whose balance endpoint does not expose usageRemainingPercent. */
  planCredits?: number;
  trialEnd?: string;
  currentPeriodEnd?: string;
  /** Trial length from the Stripe price config, available pre-subscription.
   * Absent on accounts APIs that don't expose it yet. */
  trialPeriodDays?: number;
};

export type AccountStatus = {
  signedIn: boolean;
  configured: boolean;
  localDev?: boolean;
  user?: AccountUser;
  balance?: AccountBalance;
  /** Absent when the subscription state couldn't be determined — distinct
   * from `{ subscribed: false }`. */
  subscription?: AccountSubscription;
  /** The accounts portal origin, where funding and billing live. */
  portalUrl?: string;
};

export type ReferralSummary = {
  code: string;
  url: string;
  referredCount: number;
  pendingCount: number;
  qualifiedCount: number;
  earnedMonths: number;
  appliedMonths: number;
  availableMonths: number;
};

export async function osAccountsStatus() {
  return invoke<AccountStatus>("os_accounts_status");
}

export async function osAccountsLogin() {
  return invoke<AccountStatus>("os_accounts_login");
}

export async function osAccountsCancelLogin() {
  return invoke<void>("os_accounts_cancel_login");
}

export async function osAccountsLogout() {
  return invoke<void>("os_accounts_logout");
}

export async function osAccountsUpgrade() {
  return invoke<void>("os_accounts_upgrade");
}

/** Opens the accounts portal in the default browser — the webview swallows
 * target="_blank" anchors, so portal navigation must go through Rust. */
export async function osAccountsOpenPortal() {
  return invoke<void>("os_accounts_open_portal");
}

export async function osAccountsReferralSummary() {
  return invoke<ReferralSummary>("os_accounts_referral_summary");
}

export async function dictationSettings() {
  return invoke<DictationSettingsResponse>("dictation_settings");
}

export async function listDictationHistory() {
  return invoke<ListDictationHistoryResponse>("list_dictation_history");
}

export async function deleteDictationHistoryItem(id: string) {
  return invoke<void>("delete_dictation_history_item", { id });
}

export async function providerModelSettings() {
  return invoke<ProviderModelSettingsResponse>("provider_model_settings");
}

export async function listVeniceModels(mode: ProviderModelMode) {
  return invoke<VeniceModelsResponse>("list_venice_models", {
    request: { mode },
  });
}

export async function setVeniceModel(mode: ProviderModelMode, modelId: string) {
  return invoke<ProviderModelSettingsDto>("set_venice_model", {
    request: { mode, modelId },
  });
}

export async function setDictationShortcut(
  kind: DictationShortcutKind,
  shortcut: Pick<
    DictationShortcutSetting,
    "code" | "modifiers" | "label" | "pressCount"
  >,
) {
  return invoke<DictationSettingsDto>("set_dictation_shortcut", {
    kind,
    shortcut,
  });
}

export async function setDictationMicrophone(id?: string, name?: string) {
  return invoke<DictationSettingsDto>("set_dictation_microphone", {
    id,
    name,
  });
}

export async function setDictationStyle(style: DictationStyle) {
  return invoke<DictationSettingsDto>("set_dictation_style", { style });
}

export async function setDictationLanguage(language?: string) {
  return invoke<DictationSettingsDto>("set_dictation_language", {
    language: language || undefined,
  });
}

export async function dictationHelperCommand(command: Record<string, unknown>) {
  return invoke<void>("dictation_helper_command", { command });
}

export function localAudioFileSrc(path: string) {
  return convertFileSrc(path);
}

export async function dictationHotkeyStatus() {
  return invoke<DictationHelperEvent>("dictation_hotkey_status");
}

export async function latestDictationEvent() {
  const payload = await invoke<string | undefined>("latest_dictation_event");
  return payload ? (JSON.parse(payload) as DictationHelperEvent) : undefined;
}
