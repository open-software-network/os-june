import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  AgentArtifactDto,
  AgentInterruptionDto,
  AgentItemDto,
  AgentRunDto,
  AgentRuntimeBindings,
  AgentSafetyMode,
  AgentSessionDto,
  AgentSkillDto,
  ResolveAgentInterruptionRequest,
  StartAgentRunRequest,
} from "./agent-runtime-contract";
import { parseDictationHelperEvent } from "./dictation-events";

// Re-exported so modules that build their own command calls route through the
// same `invoke` as the rest of the app's bindings.
export { invoke };

/** June-owned agent runtime command surface. Keep command spelling here so UI
 * code never depends on native transport details. */
export const agentRuntimeBindings: AgentRuntimeBindings = {
  listSessions: () => invoke<AgentSessionDto[]>("list_agent_sessions"),
  getSession: (sessionId) => invoke<AgentSessionDto>("get_agent_session", { sessionId }),
  createSession: (input) => invoke<AgentSessionDto>("create_agent_session", { request: input }),
  renameSession: (sessionId, title) =>
    invoke<AgentSessionDto>("rename_agent_session", { request: { sessionId, title } }),
  deleteSession: (sessionId) => invoke<void>("delete_agent_session", { sessionId }),
  listItems: (sessionId) => invoke<AgentItemDto[]>("list_agent_items", { sessionId }),
  startRun: (request) => invoke<AgentRunDto>("start_agent_run", { request }),
  cancelRun: (runId) => invoke<void>("cancel_agent_run", { runId }),
  retryRun: (runId) => invoke<AgentRunDto>("retry_agent_run", { runId }),
  resolveInterruption: (request) => invoke<AgentRunDto>("resolve_agent_interruption", { request }),
  listArtifacts: (sessionId) => invoke<AgentArtifactDto[]>("list_agent_artifacts", { sessionId }),
  listSkills: () => invoke<AgentSkillDto[]>("list_agent_skills"),
  setSkillEnabled: (skillId, enabled) =>
    invoke<AgentSkillDto>("set_agent_skill_enabled", { request: { skillId, enabled } }),
};

export const listAgentSessions = agentRuntimeBindings.listSessions;
export const getAgentSession = agentRuntimeBindings.getSession;
export const createAgentSession = agentRuntimeBindings.createSession;
export const renameAgentSession = agentRuntimeBindings.renameSession;
export const deleteAgentSession = agentRuntimeBindings.deleteSession;
export const listAgentItems = agentRuntimeBindings.listItems;
export const startAgentRun = (request: StartAgentRunRequest) =>
  agentRuntimeBindings.startRun(request);
export const cancelAgentRun = agentRuntimeBindings.cancelRun;
export const retryAgentRun = agentRuntimeBindings.retryRun;
export const resolveAgentInterruption = (request: ResolveAgentInterruptionRequest) =>
  agentRuntimeBindings.resolveInterruption(request);
export const listAgentArtifacts = agentRuntimeBindings.listArtifacts;
export const listAgentSkills = agentRuntimeBindings.listSkills;
export const setAgentSkillEnabled = agentRuntimeBindings.setSkillEnabled;

export type {
  AgentArtifactDto,
  AgentInterruptionDto,
  AgentItemDto,
  AgentRunDto,
  AgentSafetyMode,
  AgentSessionDto,
  AgentSkillDto,
};

export async function printCurrentWebview() {
  return invoke<void>("print_current_webview");
}

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
  instructions?: string;
  memoryDisabled: boolean;
  localPath?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaudeProjectCandidate = {
  name: string;
  path: string;
  lastUsedAt?: string;
  alreadyAdded: boolean;
};

export type MemoryDto = {
  id: string;
  folderId?: string;
  content: string;
  source: "agent" | "user";
  createdAt: string;
  updatedAt: string;
};

export type MemorySettingsDto = {
  enabled: boolean;
};

/** Which project (folder) an agent session is filed under. */
export type SessionFolderDto = {
  sessionId: string;
  folderId: string;
};

export type CompletedSessionDto = {
  sessionId: string;
  completedAt: string;
};

/** Which June profile an agent session was created under. */
export type SessionProfileDto = {
  sessionId: string;
  profile: string;
};

export type ProfileDataSummary = {
  notes: number;
  dictation: number;
  folders: number;
  sessions: number;
  memories: number;
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
  recordingSessionId?: string;
  spanId?: string;
  sourceMode?: RecordingSourceMode;
  source?: RecordingSource;
  startMs?: number;
  endMs?: number;
  turnIndex?: number;
  language?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  lastError?: string;
  recordedSilence?: boolean;
};

export const LIVE_TRANSCRIPT_EVENT = "live-transcript-event";
export const RECORDING_TELEMETRY_EVENT = "recording-telemetry";
export const NOTE_PROCESSING_PROGRESS_EVENT = "note-processing-progress";
export const NOTE_CALENDAR_CONTEXT_UPDATED_EVENT = "june://note-calendar-context-updated";

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

export type DictationCapabilitiesDto = {
  available: boolean;
  platform: "macos" | "windows" | "unsupported";
  shortcuts: boolean;
  paste: boolean;
  microphoneSelection: boolean;
  accessibilityPermission: boolean;
  systemAudio: boolean;
};

export type DictationCapabilitiesResponse = {
  capabilities: DictationCapabilitiesDto;
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
    reason?: string;
    code?: string;
    path?: string;
    durationMs?: number | string;
    observedAudioLevel?: number | string;
    level?: number | string;
    [key: string]: unknown;
  };
};

export type ProviderModelMode = "transcription" | "generation" | "image" | "video";

export type ProviderModelSettingsDto = {
  transcriptionProvider: string;
  generationProvider: string;
  transcriptionModel: string;
  generationModel: string;
  costQuality: number;
  remoteGenerationModel: string;
  imageModel: string;
  videoModel: string;
  veniceApiKeyConfigured: boolean;
  localGeneration: LocalGenerationSettingsDto;
  /** Venice safe mode for image generation/editing (blurs adult content). On
   * by default; the user opts out via Settings or the consent dialog. */
  imageSafeMode: boolean;
  /** Whether the user chose "don't ask again" on the safe-mode consent dialog. */
  imageSafeModePromptDismissed: boolean;
  /** Live transcript preview while recording. On by default; billed as extra
   * usage and disclosed in Settings, so previews from this build are sent as
   * consented (JUN-375). Off stops the preview lanes entirely. */
  liveTranscription: boolean;
};

export type ProfileModelOverridesDto = {
  transcriptionProvider?: string;
  transcriptionModel?: string;
  imageModel?: string;
  videoModel?: string;
};

export type LocalGenerationSettingsDto = {
  baseUrl: string;
  modelId: string;
  apiKey: string;
};

export type GeneratedImageDto = {
  imageBase64: string;
  mimeType: string;
  model: string;
  provider: string;
};

export type VideoJobDto = {
  jobId: string;
};

export type VideoStatusDto =
  | {
      status: "processing";
      averageExecutionMs: number;
      executionMs: number;
    }
  | {
      status: "completed";
      path: string;
      mimeType: string;
      sizeBytes: number;
      model: string;
    }
  | {
      status: "failed";
      reason: string;
    };

export type ImagePromptScreenResponse = {
  mayBeExplicit: boolean;
};

export type ProviderModelSettingsResponse = {
  settings: ProviderModelSettingsDto;
  effectiveSettings: ProviderModelSettingsDto;
};

export type P3aSettingsDto = {
  enabled: boolean;
  consentVersion: number;
  consentedAtWeek?: string | null;
};

export type P3aSettingsResponse = {
  settings: P3aSettingsDto;
};

export type P3aQuestionDto = {
  id: string;
  prompt: string;
  buckets: string[];
  decision: string;
};

export type P3aQuestionCatalogResponse = {
  questions: P3aQuestionDto[];
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
  droppedSamples?: number;
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

export type RecordingSourceTelemetryDto = Pick<
  SourceStatusDto,
  "source" | "state" | "elapsedMs" | "level" | "silenceWarning"
>;

export type RecordingTelemetryDto = Pick<
  RecordingStatusDto,
  "sessionId" | "state" | "elapsedMs" | "level" | "silenceWarning"
> & {
  sources: RecordingSourceTelemetryDto[];
  warnings: SourceWarningDto[];
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
  format: string;
  durationMs: number;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
};

export type DownloadNoteAudioResponse = {
  path: string;
  fileName: string;
  sourceCount: number;
};

export type NoteDto = NoteListItemDto & {
  calendarEvent?: NoteCalendarEventDto;
  generatedContent?: string;
  editedContent?: string;
  transcript?: TranscriptDto;
  transcriptCoverage?: TranscriptCoverageDto;
  sourceTranscripts?: TranscriptDto[];
  recording?: RecordingSessionDto;
  audio?: AudioArtifactDto;
  audioSources?: AudioArtifactDto[];
  activeTab?: "notes" | "transcription";
  lastError?: string;
  /** Recording whose saved-audio artifacts should be used by Retry. */
  retryRecordingSessionId?: string;
  /** Recordings queued behind the one currently processing (0 when none). */
  queuedRecordings?: number;
};

export type NoteProcessingProgressDto = {
  noteId: string;
  recordingSessionId: string;
  stage: "transcribing" | "generating" | "done";
  processingStatus: ProcessingStatus;
  revision: string;
};

export type NotePatchDto = Pick<
  NoteDto,
  "id" | "title" | "preview" | "editedContent" | "activeTab" | "updatedAt"
>;

export type NoteEditablePatch = Partial<Pick<NoteDto, "title" | "editedContent" | "activeTab">>;

export type NoteCalendarEventDto = {
  eventId: string;
  title: string;
  startAt: string;
  endAt: string;
  accountEmail: string;
};

export type TranscriptCoverageDto = {
  detectedSpeechMs: number;
  transcribedMs: number;
  warning: boolean;
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

export type SuggestAgentSessionTitleResponse = {
  title: string;
};

export type ImportedAgentFile = {
  name: string;
  path: string;
  rootLabel: string;
  size: number;
  previewDataUrl?: string | null;
};

export type AgentSkillInfo = {
  name: string;
  description?: string;
  category?: string;
  enabled?: boolean;
};

export type AgentSkillDocument = {
  name: string;
  relativePath: string;
  content: string;
  /** True for skills loaded from an external dir (e.g. ~/.agents/skills).
   *  June can read but not write them, so the editor is read-only. */
  readOnly?: boolean;
};

export type BootstrapResponse = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  activeRecoveries: RecoverableRecordingDto[];
  activeRecording?: RecordingStatusDto;
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
  recordedSilence?: boolean;
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
  recordedSilence?: boolean;
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
  permissionState: "unknown" | "granted" | "denied" | "restricted" | "unsupported";
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

export const JUNE_COMMUNITY_URL = "https://t.me/osjune";

/** Opens the june-api /verify page (attestation, routing, retention) in
 * the default browser. Routed through Rust because the webview drops
 * target="_blank" anchors. */
export async function juneOpenVerifyPage() {
  return invoke<void>("june_open_verify_page");
}

/** Opens the June community in the default browser. Routed through Rust for
 * the same target="_blank" reliability reason as the verify page. */
export async function juneOpenCommunityPage() {
  return invoke<void>("june_open_community_page");
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

export async function renameFolder(folderId: string, name: string, description?: string) {
  return invoke<FolderDto>("rename_folder", {
    request: { folderId, name, description },
  });
}

export async function listFolders() {
  return invoke<FolderDto[]>("list_folders");
}

export async function discoverClaudeProjects() {
  return invoke<ClaudeProjectCandidate[]>("discover_claude_projects");
}

export async function importClaudeProjects(paths: string[]) {
  return invoke<FolderDto[]>("import_claude_projects", { request: { paths } });
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

export async function assignSessionToFolder(sessionId: string, folderId: string) {
  return invoke<void>("assign_session_to_folder", {
    request: { sessionId, folderId },
  });
}

export async function listSessionProfiles() {
  return invoke<SessionProfileDto[]>("list_session_profiles");
}

export async function assignSessionToProfile(sessionId: string, profile: string) {
  return invoke<void>("assign_session_to_profile", {
    request: { sessionId, profile },
  });
}

export async function profileDataSummary(profile: string) {
  return invoke<ProfileDataSummary>("profile_data_summary", { profile });
}

export async function moveProfileDataToDefault(profile: string) {
  return invoke<void>("move_profile_data_to_default", { profile });
}

export async function deleteProfileData(profile: string) {
  return invoke<void>("delete_profile_data", { profile });
}

export async function removeSessionFromFolder(sessionId: string, folderId: string) {
  return invoke<void>("remove_session_from_folder", {
    request: { sessionId, folderId },
  });
}

export async function listCompletedSessions() {
  return invoke<CompletedSessionDto[]>("list_completed_sessions");
}

export async function setSessionCompleted(sessionId: string, completed: boolean) {
  return invoke<void>("set_session_completed", {
    request: { sessionId, completed },
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

export async function updateDictionaryEntry(input: { entryId: string; phrase: string }) {
  return invoke<DictionaryEntryDto>("update_dictionary_entry", {
    request: input,
  });
}

export async function deleteDictionaryEntry(entryId: string) {
  return invoke<void>("delete_dictionary_entry", {
    request: { entryId },
  });
}

export async function listMemories(folderId?: string, includeGlobal = false) {
  return invoke<MemoryDto[]>("list_memories", {
    folderId,
    includeGlobal,
  });
}

export async function createMemory(input: {
  folderId?: string;
  content: string;
  source: "agent" | "user";
}) {
  return invoke<MemoryDto>("create_memory", input);
}

export async function updateMemory(id: string, content: string) {
  return invoke<MemoryDto>("update_memory", { id, content });
}

export async function deleteMemory(id: string) {
  return invoke<void>("delete_memory", { id });
}

export async function setFolderInstructions(folderId: string, instructions?: string) {
  return invoke<FolderDto>("set_folder_instructions", {
    folderId,
    instructions,
  });
}

export async function setFolderMemoryDisabled(folderId: string, disabled: boolean) {
  return invoke<FolderDto>("set_folder_memory_disabled", {
    folderId,
    disabled,
  });
}

export async function memorySettings() {
  return invoke<MemorySettingsDto>("memory_settings");
}

export async function setMemoryEnabled(enabled: boolean) {
  return invoke<MemorySettingsDto>("set_memory_enabled", { enabled });
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
  width?: number;
  height?: number;
}) {
  return invoke<void>("agent_hud_set_layout", { request: input });
}

export async function agentHudOpenAgent(session?: AgentSessionDto) {
  return invoke<void>("agent_hud_open_agent", { session });
}

export async function sendAppNotification(input: {
  title: string;
  body: string;
  sound?: string;
  group?: string;
  sessionId?: string;
}) {
  return invoke<void>("send_app_notification", { request: input });
}

/**
 * Tells the backend the webview can receive "june:agent:open" events and
 * returns the session id of a notification clicked before that (the click
 * launched the app), so bootstrap can navigate straight to it.
 */
export async function agentOpenReady() {
  return invoke<string | null>("agent_open_ready");
}

export type PendingMeetingStartRequest = {
  requestId: string;
  noteId: string;
  requestedAtMs: number;
  expired: boolean;
};

export async function pendingMeetingStartRequest() {
  return invoke<PendingMeetingStartRequest | null>("pending_meeting_start_request");
}

export async function acknowledgeMeetingStartRequest(requestId: string) {
  return invoke<boolean>("acknowledge_meeting_start_request", { requestId });
}

export type SubmitIssueReportRequest = {
  /** Which kind of report this is: "bug" | "feedback" | "feature". Drives the
   * team's triage. Direct dialog reports run no model turn, so there is
   * nothing to charge; June API creates the team-facing diagnosis. */
  category?: string;
  /** The user's report as they typed it, before the investigation wrapper. */
  description: string;
  /** June's diagnostic assessment from the report session, when available. */
  agentDiagnosis?: string;
  attachmentNames: string[];
  /** Original local paths from the report picker or workspace paths created
   * for DOM-dropped files; their bytes are sent with the report. */
  attachmentPaths: string[];
  sessionId?: string;
};

export type SubmitIssueReportResponse = {
  received: boolean;
  /** Names of files that could not be attached to the report, either because
   * the local file was unreadable or empty or Open Software rejected it. */
  skippedAttachmentNames?: string[];
};

export async function submitIssueReport(request: SubmitIssueReportRequest) {
  return invoke<SubmitIssueReportResponse>("submit_issue_report", { request });
}

export type ExplainAgentApprovalResponse = {
  explanation: string;
};

/** One-shot generation call that explains a pending approval request in
 * plain language — the agent runtime stays parked on the approval. */
export async function explainAgentApproval(input: { description: string; command?: string }) {
  return invoke<ExplainAgentApprovalResponse>("explain_agent_approval", {
    request: input,
  });
}

export async function agentFilePreview(path: string) {
  return invoke<string | null>("read_agent_artifact_preview", { request: { path } });
}

export async function agentFileText(path: string) {
  return invoke<string | null>("read_agent_artifact_text", { request: { path } });
}

export async function revealPath(path: string) {
  return invoke<void>("reveal_path", { path });
}

export async function unpackBundledExtension() {
  return invoke<string>("unpack_bundled_extension");
}

export async function listNotes(folderId?: string, limit?: number) {
  return invoke<ListNotesResponse>("list_notes", { request: { folderId, limit } });
}

export async function getNote(noteId: string) {
  return invoke<NoteDto>("get_note", { request: { noteId } });
}

export async function downloadNoteAudio(noteId: string) {
  return invoke<DownloadNoteAudioResponse>("download_note_audio", {
    request: { noteId },
  });
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

export async function patchNote(noteId: string, patch: NoteEditablePatch) {
  return invoke<NotePatchDto>("update_note", {
    request: { noteId, ...patch, patchOnly: true },
  });
}

export const NOTE_SAVE_FLUSH_REQUESTED_EVENT = "june://flush-pending-note-saves";

export async function completeNoteSaveFlush(requestId: string) {
  return invoke<boolean>("complete_note_save_flush", { request: { requestId } });
}

export async function checkRecordingSourceReadiness(sourceMode: RecordingSourceMode) {
  return invoke<RecordingSourceReadinessDto>("check_recording_source_readiness", {
    request: { sourceMode },
  });
}

export async function openPrivacySettings(
  pane: "microphone" | "accessibility" | "screenRecording" | "systemAudio",
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

export type MeetingStartRecordingOutcome =
  | {
      status: "started";
      note: NoteDto;
      recording: RecordingSessionDto;
    }
  | {
      status: "failed";
      error: { code: string; message: string };
    };

export async function startMeetingRecording(
  requestId: string,
  sourceMode: RecordingSourceMode = "microphoneOnly",
) {
  return invoke<MeetingStartRecordingOutcome>("start_meeting_recording", {
    request: { requestId, sourceMode },
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

export type ResolveAgentRecorderRequestInput = {
  requestId: string;
  ok: boolean;
  noteId?: string;
  noteTitle?: string;
  errorCode?: string;
  errorMessage?: string;
};

export async function resolveAgentRecorderRequest(request: ResolveAgentRecorderRequestInput) {
  return invoke<void>("resolve_agent_recorder_request", { request });
}

export async function retryProcessing(noteId: string, recordingSessionId?: string) {
  return invoke<NoteDto>("retry_processing", {
    request: recordingSessionId
      ? { noteId, step: "all", recordingSessionId }
      : { noteId, step: "all" },
  });
}

export async function recoverRecording(sessionId: string, action: "validate" | "discard") {
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
  avatarSeed?: string;
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

export type SubscriptionPlan = "pro" | "max";

export type AccountSubscription = {
  subscribed: boolean;
  status?: "trialing" | "active" | "past_due" | "canceled" | (string & {});
  /** Plan slug from OS Accounts. Absent on accounts APIs that predate plan
   * tiers and on legacy subscription rows, which are all Pro. */
  plan?: SubscriptionPlan | (string & {});
  /** Monthly plan credits returned by OS Accounts. Used as a fallback for
   * deployments whose balance endpoint does not expose usageRemainingPercent. */
  planCredits?: number;
  trialEnd?: string;
  currentPeriodEnd?: string;
  /** Trial length from the Stripe price config, available pre-subscription.
   * Absent on accounts APIs that don't expose it yet. */
  trialPeriodDays?: number;
  /** Plan a scheduled downgrade switches to at the period end. Additive on
   * the plan-change endpoint; absent everywhere else. */
  scheduledPlan?: SubscriptionPlan | (string & {});
  scheduledPlanCredits?: number;
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

/** Keychain-only status with no network I/O — the launch fast-path so first
 * paint doesn't block on the account snapshot. User/balance stay unknown until
 * the full `osAccountsStatus` lands. */
export async function osAccountsStatusLocal() {
  return invoke<AccountStatus>("os_accounts_status_local");
}

export async function osAccountsLogin() {
  return invoke<AccountStatus>("os_accounts_login");
}

export async function osAccountsCancelLogin() {
  return invoke<void>("os_accounts_cancel_login");
}

export type AccountsLogoutOptions = {
  clearBrowserSession?: boolean;
};

export async function osAccountsLogout(options: AccountsLogoutOptions = {}) {
  return invoke<void>("os_accounts_logout", {
    request: { clearBrowserSession: options.clearBrowserSession ?? false },
  });
}

/** Persist an explicit Avatar v1 selection on the signed-in OS Accounts User. */
export async function osAccountsSetAvatarSeed(seed: string) {
  return invoke<AccountUser>("os_accounts_set_avatar_seed", { seed });
}

/** Opens subscription checkout in the browser. Omitting `plan` keeps the
 * accounts-API default (Pro). */
export async function osAccountsUpgrade(plan?: SubscriptionPlan) {
  return invoke<void>("os_accounts_upgrade", { plan });
}

/** Opens a hosted billing-portal session for an existing subscriber to review
 * and confirm a full-price plan upgrade that restarts the billing cycle. */
export async function osAccountsUpgradeSession(plan: SubscriptionPlan) {
  return invoke<void>("os_accounts_upgrade_session", { plan });
}

/** Changes the plan on the caller's existing subscription in place (Pro to
 * Max), charging the saved card immediately with no browser review. This is
 * the compatibility fallback for deployments without hosted upgrade
 * sessions, and callers must only dispatch it behind the charge-now consent
 * copy. Credits still arrive only through the invoice webhook, so callers
 * poll account status until the grant lands. */
export async function osAccountsChangePlan(plan: SubscriptionPlan) {
  return invoke<AccountSubscription>("os_accounts_change_plan", { plan });
}

/** Opens the accounts portal in the default browser — the webview swallows
 * target="_blank" anchors, so portal navigation must go through Rust. */
export async function osAccountsOpenPortal() {
  return invoke<void>("os_accounts_open_portal");
}

export async function osAccountsReferralSummary() {
  return invoke<ReferralSummary>("os_accounts_referral_summary");
}

export async function dictationCapabilities() {
  return invoke<DictationCapabilitiesResponse>("dictation_capabilities");
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

export async function profileModelOverrides(profile: string) {
  return invoke<ProfileModelOverridesDto | null>("profile_model_overrides", { profile });
}

export async function setProfileModelOverrides(
  profile: string,
  overrides: ProfileModelOverridesDto,
) {
  return invoke<void>("set_profile_model_overrides", { profile, overrides });
}

export async function deleteProfileModelOverrides(profile: string) {
  return invoke<void>("delete_profile_model_overrides", { profile });
}

export async function p3aSettings() {
  return invoke<P3aSettingsResponse>("p3a_settings");
}

export async function p3aQuestionCatalog() {
  return invoke<P3aQuestionCatalogResponse>("p3a_question_catalog");
}

export async function setP3aEnabled(enabled: boolean) {
  return invoke<P3aSettingsResponse>("set_p3a_enabled", {
    request: { enabled },
  });
}

export async function p3aRecord(questionId: string) {
  return invoke<void>("p3a_record", {
    request: { questionId },
  });
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

export async function setCostQuality(value: number) {
  return invoke<ProviderModelSettingsDto>("set_cost_quality", {
    request: { value },
  });
}

export async function setVeniceApiKey(apiKey: string) {
  return invoke<ProviderModelSettingsDto>("set_venice_api_key", {
    request: { apiKey },
  });
}

export async function clearVeniceApiKey() {
  return invoke<ProviderModelSettingsDto>("clear_venice_api_key");
}

// Toggles Venice safe mode for image generation/editing. On by default; when
// on, Venice blurs adult content.
export async function setImageSafeMode(enabled: boolean) {
  return invoke<ProviderModelSettingsDto>("set_image_safe_mode", {
    request: { enabled },
  });
}

// Toggles the live transcript preview while recording. On by default; billed
// as extra usage when on, no preview audio leaves the device when off.
export async function setLiveTranscription(enabled: boolean) {
  return invoke<ProviderModelSettingsDto>("set_live_transcription", {
    request: { enabled },
  });
}

export async function setImageSafeModePromptDismissed(dismissed: boolean) {
  return invoke<ProviderModelSettingsDto>("set_image_safe_mode_prompt_dismissed", {
    request: { dismissed },
  });
}

/** Screens an image prompt for the safe-mode consent dialog. */
export async function imagePromptMayBeExplicit(prompt: string): Promise<boolean> {
  const response = await invoke<ImagePromptScreenResponse>("image_prompt_may_be_explicit", {
    request: { prompt },
  });
  return response.mayBeExplicit;
}

// Generates an image from a prompt via the June API. `model` is optional; the
// backend falls back to the saved default image model when it is omitted.
// `safeMode` pins the safe-mode value a retry must replay; omitted uses the
// live saved setting.
export async function generateImage(
  prompt: string,
  model?: string,
  requestId?: string,
  safeMode?: boolean,
) {
  return invoke<GeneratedImageDto>("generate_image", {
    request: { prompt, model, requestId, safeMode },
  });
}

export async function editImage(input: {
  imageBase64: string;
  prompt: string;
  mimeType?: string;
  model?: string;
  requestId?: string;
}) {
  return invoke<GeneratedImageDto>("edit_image", {
    request: {
      image: input.imageBase64,
      prompt: input.prompt,
      mimeType: input.mimeType,
      model: input.model,
      requestId: input.requestId,
    },
  });
}

export async function videoGenerate(input: {
  prompt: string;
  model?: string;
  requestId?: string;
  duration?: string;
  resolution?: string;
  aspectRatio?: string;
  audio?: boolean;
}) {
  return invoke<VideoJobDto>("video_generate", {
    request: input,
  });
}

export async function videoStatus(jobId: string) {
  return invoke<VideoStatusDto>("video_status", {
    request: { jobId },
  });
}

/** Persists the local endpoint, model id, and optional API key. Strictly
 * validated backend-side (any http/https URL with a host is accepted) and it
 * never changes the active provider — enabling is a separate step. */
export async function saveLocalGenerationSettings(input: {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}) {
  return invoke<ProviderModelSettingsDto>("save_local_generation_settings", {
    request: input,
  });
}

/** Flips generation between the saved local endpoint and the remote model.
 * Enabling requires saved settings (the backend errors otherwise); disabling
 * restores the remote provider without touching the stored local fields. */
export async function setLocalGenerationEnabled(enabled: boolean) {
  return invoke<ProviderModelSettingsDto>("set_local_generation_enabled", {
    request: { enabled },
  });
}

/** GETs {baseUrl}/models with an optional bearer token (~10s timeout) and
 * returns the advertised model ids, for the settings "Test connection" flow. */
export async function probeLocalGenerationEndpoint(input: { baseUrl: string; apiKey: string }) {
  return invoke<{ models: string[] }>("probe_local_generation_endpoint", {
    request: input,
  });
}

export async function setDictationShortcut(
  kind: DictationShortcutKind,
  shortcut: Pick<DictationShortcutSetting, "code" | "modifiers" | "label" | "pressCount">,
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

let generatedVideoDirCache: string | undefined;

/** Preload the generated-videos directory so localVideoFileSrc can resolve a
 * bare `generated-video-*.mp4` filename — the agent frequently refers to a
 * finished video by filename only — to an absolute, asset-scoped path the
 * webview can load. Best-effort; call once on mount. */
export async function primeGeneratedVideoDir(): Promise<void> {
  try {
    generatedVideoDirCache = await invoke<string>("generated_video_dir");
  } catch {
    // Non-fatal: absolute MEDIA paths still resolve without the cache.
  }
}

function isAbsoluteVideoPath(path: string) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

export function localVideoFileSrc(path: string) {
  // A bare generated-video filename resolves against the cached videos dir; an
  // absolute path (fast-path result, or an absolute MEDIA ref) is used as-is.
  const resolved =
    isAbsoluteVideoPath(path) || !generatedVideoDirCache
      ? path
      : `${generatedVideoDirCache}/${path}`;
  return convertFileSrc(resolved);
}

export async function dictationHotkeyStatus() {
  return invoke<DictationHelperEvent>("dictation_hotkey_status");
}

export async function latestDictationEvent() {
  const payload = await invoke<string | undefined>("latest_dictation_event");
  return parseDictationHelperEvent(payload);
}

// --- Browser extension pairing (JUN-287) ---

export type ExtensionPairingStatus = {
  paired: boolean;
  listenerRunning: boolean;
  extensionVersion?: string;
  protocolVersion?: number;
};

/** Emitted by the extension host whenever pairing state changes. */
export const EXTENSION_PAIRING_CHANGED_EVENT = "june://extension-pairing-changed";

export async function extensionPairingStatus() {
  return invoke<ExtensionPairingStatus>("extension_pairing_status");
}

export type RegisterBrowserExtensionHostResult = {
  manifestPath: string;
  shimPath: string;
};

/** Writes native messaging host manifests for the supported Chromium-family
 * browsers, pinning the June extension id to the bundled shim. */
export async function registerBrowserExtensionHost() {
  return invoke<RegisterBrowserExtensionHostResult>("register_browser_extension_host");
}

export type RoutineBrowserAccess = {
  enabled: boolean;
  serverName?: string | null;
};

export async function routineBrowserAccessGet(jobId: string) {
  return invoke<RoutineBrowserAccess>("routine_browser_access_get", { jobId });
}

export async function routineBrowserAccessSet(input: { jobId: string; enabled: boolean }) {
  return invoke<RoutineBrowserAccess>("routine_browser_access_set", {
    request: input,
  });
}

// ---------------------------------------------------------------------------
// Private connectors (local mode): Google and Linear
// ---------------------------------------------------------------------------

/** Stable feature-bundle id supplied by the native connector policy. */
export type ConnectorScopeBundle = string;

export type ConnectorAccountStatus = "connected" | "reconnect_required" | "unavailable";

export type ConnectorProvider = "google" | "linear" | "notion" | "github";

export type ConnectorPolicyCatalog = {
  version: number;
  providers: Array<{
    id: ConnectorProvider;
    connectFlow: "oauth" | "hosted_mcp";
    enabled: boolean;
    defaultBundles: ConnectorScopeBundle[];
  }>;
  scopeBundles: Array<{
    id: ConnectorScopeBundle;
    provider: ConnectorProvider;
    scopeIds: string[];
  }>;
  scopeImplications: Array<{
    held: string;
    grants: string[];
  }>;
  servers: Array<{
    id: string;
    provider: ConnectorProvider;
    kind: "read" | "action";
  }>;
  serverOwnerPrefixes: Array<{
    prefix: string;
    provider: ConnectorProvider;
  }>;
  actionTools: Array<{
    id: string;
    server: string;
    provider: ConnectorProvider;
    grantable: boolean;
  }>;
  triggers: Array<{
    id: ConnectorTriggerKind;
    provider: ConnectorProvider;
    requiredBundles: ConnectorScopeBundle[];
  }>;
  routine: {
    sandboxedBaseToolsets: string[];
    readToolsets: string[];
    actionToolsets: string[];
    autonomousServerPrefixes: string[];
  };
  earnedAutonomyMinApprovalRuns: number;
};

/** One Linear team: the granularity June's Linear read/write access is
 * scoped to. Returned both by the live team list and on the account once
 * selected. */
export type LinearTeam = {
  id: string;
  key: string;
  name: string;
};

/** One connected connector account, as the connectors module reports it.
 * Carries only metadata (identity, granted scopes, health) — never a token.
 * Google and Notion rows leave `workspaceName`/`workspaceUrlKey` null and
 * `selectedTeams` empty. A Linear row's `accountId` is the Linear workspace
 * id (an opaque UUID, not an email); `email` is the signed-in Linear user's
 * email and may be empty. */
export type ConnectorAccount = {
  accountId: string;
  provider: ConnectorProvider;
  email: string;
  /** Granted scope identifiers: Google's full auth URLs, Linear's short
   * scope names ("read", "write") — not bundle names. Empty for Notion preview. */
  scopes: string[];
  status: ConnectorAccountStatus;
  /** Linear workspace display name; null for Google rows. */
  workspaceName: string | null;
  /** Linear workspace URL key (the org's linear.app subdomain segment);
   * null for Google rows. */
  workspaceUrlKey: string | null;
  /** Linear teams June may read/write on this workspace. Empty for Google
   * rows, and for a fresh Linear connect before the user finishes team
   * selection. */
  selectedTeams: LinearTeam[];
};

/** Per-routine trust mode for connector action tools. Distinct from the
 * Sandboxed/Unrestricted machine-access choice: trust governs what a routine
 * may do with your Google account, not with your machine. */
export type RoutineTrustMode = "read_only" | "approval" | "autonomous";

export type RoutineTrust = {
  trustMode: RoutineTrustMode;
  /** Completed approval-mode runs; >= 3 unlocks autonomous. */
  approvalRunCount: number;
  /** Connector action tool names the user granted for autonomous runs. */
  autonomousTools: string[];
  /** Per-job auto MCP server names minted for an autonomous grant (e.g.
   * "june_gmail_auto_ab12cd34"). Returned by routine_trust_set; the job's
   * enabled_toolsets swaps the actions servers for these. */
  autonomousServers?: string[];
};

export type ConnectorTriggerKind = "email_received" | "event_upcoming";

export type ConnectorTrigger = {
  id: string;
  jobId: string;
  kind: ConnectorTriggerKind;
  accountId: string;
  /** Kind-specific settings: event_upcoming carries `leadMinutes` (number)
   * and `externalOnly` (boolean); email_received carries none today. */
  config: Record<string, unknown>;
};

/** One connector action call parked in the Rust proxy waiting for the user.
 * `argsPreview` is already redacted on the Rust side. */
export type PendingConnectorApproval = {
  approvalId: string;
  tool: string;
  server: string;
  accountEmail: string;
  summary: string;
  argsPreview: string;
  requestedAtMs: number;
};

/** One attended Browser use action parked in the Rust broker. Page content is
 * limited to the exact origin and element label needed for informed consent. */
export type PendingBrowserApproval = {
  approvalId: string;
  site: string;
  action: "click" | "fill" | "press";
  elementLabel: string;
  requestedAtMs: number;
};

export type ComputerUseStatusDto = {
  platformSupported: boolean;
  planEligible: boolean;
  grantEnabled: boolean;
  driverAvailable: boolean;
  driverVersion?: string;
  accessibility: boolean;
  screenRecording: boolean;
  modelSupportsVision: boolean;
  generationModel: string;
  ready: boolean;
  state:
    | "off"
    | "permission_missing"
    | "model_unsupported"
    | "plan_required"
    | "ready"
    | "unsupported"
    | "driver_missing"
    | "driver_mismatch"
    | "rollout_disabled"
    | "error"
    | (string & {});
  error?: string;
};

/** One state-changing Computer use call parked in the app-owned Rust broker.
 * The capture path, when present, is already scoped for read-only asset access
 * by the native shell. */
export type PendingComputerUseApprovalDto = {
  approvalId: string;
  actionId: string;
  action: string;
  targetApp: string;
  summary: string;
  capturePath?: string;
  requestedAtMs: number;
  expiresAtMs: number;
};

/** Tauri event: the connected-accounts list changed (connect, disconnect, or
 * a reconnect_required transition). Payload carries no account data; listeners
 * re-fetch via connectorsList(). */
export const CONNECTORS_CHANGED_EVENT = "june://connectors-changed";

/** Payload emitted by `june://connectors-github-device-code` while a GitHub
 * device-flow connect is in progress. May be emitted more than once (a
 * restarted poll re-emits the latest code). The backend opens the
 * verification page itself; the UI still shows the code as a fallback. */
export type GitHubDeviceCodePayload = {
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
};

/** Tauri event: a GitHub device-authorization code is ready to display.
 * Emitted while `connectors_connect` is pending for provider "github". */
export const GITHUB_DEVICE_CODE_EVENT = "june://connectors-github-device-code";

/** Tauri event: the pending connector-approval set changed.
 * Payload: `{ pendingCount: number }`. */
export const CONNECTOR_APPROVALS_CHANGED_EVENT = "june://connector-approvals-changed";

/** Tauri event: the app-owned Computer use approval queue changed.
 * Payload: `{ pendingCount: number }`. */
export const COMPUTER_USE_APPROVALS_CHANGED_EVENT = "june://computer-use-approvals-changed";

/** Browser-local signal used to keep the Plugins and Settings fronts in sync
 * after either one changes the single native grant. */
export const COMPUTER_USE_STATUS_CHANGED_EVENT = "june:computer-use-status-changed";

export async function connectorsList() {
  return invoke<ConnectorAccount[]>("connectors_list");
}

/** Runs the OAuth connect flow for the given provider and feature bundles.
 * Blocks until the browser flow completes (the Rust side enforces a 300s
 * timeout). `provider` defaults to Google on the Rust side when omitted.
 * `loginHint` pre-selects the account to reconnect or add scope to: a Google
 * email for Google, the workspace's `accountId` for Linear (Linear
 * escalates by workspace, not by user email). */
export async function connectorsConnect(input: {
  scopes: ConnectorScopeBundle[];
  loginHint?: string;
  provider?: ConnectorProvider;
}) {
  return invoke<ConnectorAccount>("connectors_connect", {
    request: { scopes: input.scopes, loginHint: input.loginHint, provider: input.provider },
  });
}

export async function connectorsCancelConnect() {
  return invoke<void>("connectors_cancel_connect");
}

export type NotionConnectionStatus = {
  connected: boolean;
  accountId: string;
  endpoint: string;
  preview: boolean;
  selectedResourceScopingVerified: boolean;
  accessTokenPresent: boolean;
  refreshTokenPresent: boolean;
  clientIdPresent: boolean;
  keychainOnly: boolean;
};

export type NotionConnection = {
  accountId: string;
  endpoint: string;
  preview: boolean;
  selectedResourceScopingVerified: boolean;
};

export type NotionToolSummary = {
  name: string;
  description?: string;
  writeClass: string;
};

export type NotionToolInventory = {
  endpoint: string;
  protocolVersion: string;
  toolCount: number;
  tools: NotionToolSummary[];
  sessionEstablished: boolean;
  inventoryBytes: number;
};

export async function notionConnectorStatus() {
  return invoke<NotionConnectionStatus>("notion_connector_status");
}

export async function notionConnectorConnect() {
  return invoke<NotionConnection>("notion_connector_connect");
}

export async function notionConnectorCancelConnect() {
  return invoke<void>("notion_connector_cancel_connect");
}

export async function notionConnectorDisconnect() {
  return invoke<void>("notion_connector_disconnect");
}

export async function notionConnectorListTools() {
  return invoke<NotionToolInventory>("notion_connector_list_tools");
}

/** Removes a connected account. With `revoke`, also revokes June's grant with
 * the provider before clearing the Keychain item. */
export async function connectorsDisconnect(input: { accountId: string; revoke: boolean }) {
  return invoke<void>("connectors_disconnect", {
    request: { accountId: input.accountId, revoke: input.revoke },
  });
}

/** The live team listing for the selection dialog. `truncated` means the
 * Rust side's pagination cap cut the listing short, so the UI must not
 * present it as the complete team inventory. */
export type LinearTeamsResult = {
  teams: LinearTeam[];
  truncated: boolean;
};

/** Lists the Linear teams the connected workspace's user can see, for the
 * team-selection dialog. A live call, not cached client-side: a workspace's
 * teams can change between visits. */
export async function connectorsLinearTeams(input: { accountId: string }) {
  return invoke<LinearTeamsResult>("connectors_linear_teams", {
    request: { accountId: input.accountId },
  });
}

/** Persists which Linear teams June may read/write on this workspace.
 * Returns the updated account with `selectedTeams` set. The Rust side
 * rejects an empty team list, so a workspace mid-setup stays in the
 * "unfinished" state rather than recording zero teams on purpose. */
export async function connectorsSetSelectedTeams(input: {
  accountId: string;
  teams: LinearTeam[];
}) {
  return invoke<ConnectorAccount>("connectors_selected_teams_set", {
    request: { accountId: input.accountId, teams: input.teams },
  });
}

export type ObsidianStatus = {
  connected: boolean;
  /** False when a saved vault is currently missing or cannot be validated.
   * Optional so older desktop responses remain compatible. */
  available?: boolean;
  vaultPath?: string;
  vaultName?: string;
};

export async function obsidianStatus() {
  return invoke<ObsidianStatus>("obsidian_status");
}

export async function obsidianConfigure(vaultPath: string) {
  return invoke<ObsidianStatus>("obsidian_configure", {
    request: { vaultPath },
  });
}

export async function obsidianDisconnect() {
  return invoke<ObsidianStatus>("obsidian_disconnect");
}

export async function connectorsApplyRuntime() {
  return invoke<void>("connectors_apply_runtime");
}

export async function routineTrustGet(jobId: string) {
  return invoke<RoutineTrust | null>("routine_trust_get", { jobId });
}

/** Persists a routine's trust mode. Errors with code
 * "routine_trust_not_earned" when autonomous is requested before the earned
 * threshold. Returns the stored record, including any minted
 * `autonomousServers` for an autonomous grant. */
export async function routineTrustSet(input: {
  jobId: string;
  trustMode: RoutineTrustMode;
  autonomousTools?: string[];
}) {
  return invoke<RoutineTrust>("routine_trust_set", {
    request: {
      jobId: input.jobId,
      trustMode: input.trustMode,
      autonomousTools: input.autonomousTools,
    },
  });
}

/** Credits a completed run toward the earned-autonomy threshold. Idempotent
 * per run id and gated on the routine being in approval mode with the run
 * finishing after approval was enabled, so it is safe to call for every
 * finished run. Returns the updated record, or null when nothing was credited. */
export async function routineTrustRecordRun(input: {
  jobId: string;
  runId: string;
  runEndedAt: string;
}) {
  return invoke<RoutineTrust | null>("routine_trust_record_run", {
    request: {
      jobId: input.jobId,
      runId: input.runId,
      runEndedAt: input.runEndedAt,
    },
  });
}

export async function connectorTriggersList(jobId?: string) {
  return invoke<ConnectorTrigger[]>("connector_triggers_list", { jobId });
}

/** Upserts the event trigger for a routine (one trigger per job). */
export async function connectorTriggerSet(input: {
  jobId: string;
  kind: ConnectorTriggerKind;
  accountId: string;
  config: Record<string, unknown>;
}) {
  return invoke<ConnectorTrigger>("connector_trigger_set", {
    request: {
      jobId: input.jobId,
      kind: input.kind,
      accountId: input.accountId,
      config: input.config,
    },
  });
}

export async function connectorTriggerDelete(id: string) {
  return invoke<void>("connector_trigger_delete", { id });
}

export async function connectorApprovalsPending() {
  return invoke<PendingConnectorApproval[]>("connector_approvals_pending");
}

export async function connectorApprovalRespond(input: { approvalId: string; approve: boolean }) {
  return invoke<void>("connector_approval_respond", {
    approvalId: input.approvalId,
    approve: input.approve,
  });
}

export async function connectorApprovalsRespondAll(input: {
  approve: boolean;
  approvalIds: string[];
}) {
  return invoke<void>("connector_approvals_respond_all", {
    approve: input.approve,
    approvalIds: input.approvalIds,
  });
}

export async function browserApprovalsPending() {
  return invoke<PendingBrowserApproval[]>("browser_approvals_pending");
}

export async function browserApprovalRespond(input: {
  approvalId: string;
  approve: boolean;
  allowSite?: boolean;
}) {
  return invoke<void>("browser_approval_respond", {
    approvalId: input.approvalId,
    approve: input.approve,
    allowSite: input.allowSite ?? false,
  });
}

export async function computerUseStatus() {
  return invoke<ComputerUseStatusDto>("computer_use_status");
}

export async function setComputerUseGrant(enabled: boolean) {
  return invoke<ComputerUseStatusDto>("set_computer_use_grant", {
    request: { enabled },
  });
}

export async function computerUseRequestPermissions() {
  return invoke<ComputerUseStatusDto>("computer_use_request_permissions");
}

export async function setComputerUsePermissionDragBounds(
  bounds: RecordingPresenceBoundsDto | null,
  target?: "helper" | "host",
) {
  return invoke<void>("set_computer_use_permission_drag_bounds", {
    request: { bounds, target: bounds ? target : undefined },
  });
}

export async function computerUseStop() {
  return invoke<{ stopped: boolean }>("computer_use_stop");
}

export async function computerUseBeginRun(sessionId: string) {
  return invoke<void>("computer_use_begin_run", {
    request: { sessionId },
  });
}

export async function computerUseEndRun(sessionId: string) {
  return invoke<void>("computer_use_end_run", {
    request: { sessionId },
  });
}

export async function computerUseApprovalsPending() {
  return invoke<PendingComputerUseApprovalDto[]>("computer_use_approvals_pending");
}

export async function respondComputerUseApproval(input: { approvalId: string; approve: boolean }) {
  return invoke<void>("computer_use_approval_respond", {
    request: { approvalId: input.approvalId, approve: input.approve },
  });
}

export function computerUseCaptureSrc(path: string) {
  return convertFileSrc(path);
}

// ---- Private sharing (JUN-308) -------------------------------------------
// Owner-side share commands. Ciphertext, IVs, envelopes, and locally stored
// keys cross the IPC boundary as base64url strings; plaintext and unwrapped
// keys never leave the webview (see src/lib/share-crypto.ts).

export type ShareKind = "note" | "session";

export type ShareInviteState = "pending" | "accepted" | "revoked";

export type ShareInvitePayload = {
  email: string;
  envelopeB64: string;
  envelopeIvB64: string;
};

export type ShareCreatedInviteDto = {
  inviteId: string;
  email: string;
};

export type ShareCreatedDto = {
  shareId: string;
  invites: ShareCreatedInviteDto[];
};

// `POST /v1/shares/{id}/invites` returns only the new invites (no shareId).
export type ShareInvitesAddedDto = {
  invites: ShareCreatedInviteDto[];
};

// `GET /v1/shares` returns summaries only; invites live on the detail response.
export type ShareSummaryDto = {
  shareId: string;
  kind: ShareKind;
  createdAt?: string;
};

export type ShareInviteDto = {
  inviteId: string;
  email: string;
  state: ShareInviteState;
  lastAccessAt?: string;
};

export type ShareDto = {
  shareId: string;
  kind: ShareKind;
  createdAt?: string;
  invites: ShareInviteDto[];
};

export type ShareKeyDto = {
  shareId: string;
  contentKeyB64: string;
};

export type ShareInviteKeyDto = {
  inviteId: string;
  inviteKeyB64: string;
};

export async function shareCreate(input: {
  kind: ShareKind;
  ciphertextB64: string;
  ivB64: string;
  invites: ShareInvitePayload[];
}) {
  return invoke<ShareCreatedDto>("share_create", { request: input });
}

export async function shareList() {
  return invoke<ShareSummaryDto[]>("share_list");
}

export async function shareGet(shareId: string) {
  return invoke<ShareDto>("share_get", { request: { shareId } });
}

export async function shareAddInvites(shareId: string, invites: ShareInvitePayload[]) {
  return invoke<ShareInvitesAddedDto>("share_add_invites", { request: { shareId, invites } });
}

export async function shareRevokeInvite(shareId: string, inviteId: string) {
  return invoke<void>("share_revoke_invite", { request: { shareId, inviteId } });
}

export async function shareDelete(shareId: string) {
  return invoke<void>("share_delete", { request: { shareId } });
}

export async function shareKeySave(input: {
  shareId: string;
  itemKind: ShareKind;
  itemId: string;
  contentKeyB64: string;
}) {
  return invoke<void>("share_key_save", { request: input });
}

export async function shareKeyGet(itemKind: ShareKind, itemId: string) {
  return invoke<ShareKeyDto | null>("share_key_get", { request: { itemKind, itemId } });
}

export async function shareInviteKeySave(input: {
  inviteId: string;
  shareId: string;
  inviteKeyB64: string;
}) {
  return invoke<void>("share_invite_key_save", { request: input });
}

export async function shareInviteKeysGet(shareId: string) {
  return invoke<ShareInviteKeyDto[]>("share_invite_keys_get", { request: { shareId } });
}

export async function getShareBaseUrl() {
  return invoke<string>("get_share_base_url");
}
