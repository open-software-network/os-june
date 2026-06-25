import { convertFileSrc, invoke } from "@tauri-apps/api/core";

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

/** Opens the scribe-api /verify page (attestation, routing, retention) in
 * the default browser. Routed through Rust because the webview drops
 * target="_blank" anchors. */
export async function scribeOpenVerifyPage() {
  return invoke<void>("scribe_open_verify_page");
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
  usdMillis: number;
};

export type AccountSubscription = {
  subscribed: boolean;
  status?: "trialing" | "active" | "past_due" | "canceled" | (string & {});
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
  /** The accounts portal origin, where the free-trial flow lives. */
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

export async function osAccountsTopUp() {
  return invoke<void>("os_accounts_top_up");
}

/** Opens the accounts portal in the default browser — the webview swallows
 * target="_blank" anchors, so portal navigation must go through Rust. */
export async function osAccountsOpenPortal() {
  return invoke<void>("os_accounts_open_portal");
}

export async function osAccountsReferralSummary() {
  return invoke<ReferralSummary>("os_accounts_referral_summary");
}

export type TrialCheckoutResult = {
  outcome: "checkoutOpened" | "alreadySubscribed";
};

export type TrialCheckoutPreparedResult = {
  outcome: "ready" | "alreadySubscribed";
};

/** Pre-mints the free-trial Stripe Checkout session and caches it in the
 * Rust core, so the next start call only has to open the browser. Call it
 * while the user is reading the trial pitch; failures are safe to swallow,
 * the start path falls back to minting on the spot. */
export async function osAccountsPrepareTrialCheckout() {
  return invoke<TrialCheckoutPreparedResult>(
    "os_accounts_prepare_trial_checkout",
  );
}

/** Mints the free-trial Stripe Checkout session with the user's own token and
 * opens it in the system browser — no portal detour. Rejects with code
 * `trial_checkout_needs_reauth` when the stored grant lacks the billing
 * scope (callers re-run sign-in and retry), and with other codes when the
 * direct path is unavailable (subscriptions disabled, network); callers
 * answer those with the portal fallback. */
export async function osAccountsStartTrialCheckout() {
  return invoke<TrialCheckoutResult>("os_accounts_start_trial_checkout");
}

/** Bring the app window back to the foreground — used when checkout completes
 * in the browser so the user lands back in June. */
export async function focusMainWindow() {
  return invoke<void>("focus_main_window");
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
