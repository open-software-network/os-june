export const AGENT_RUNTIME_PROTOCOL_VERSION = 1 as const;

export type AgentSafetyMode = "sandboxed" | "unrestricted";
export type AgentSessionStatus =
  | "idle"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "interrupted"
  | "failed";

export type AgentSessionSource = "user" | "legacy_routine" | "legacy_task";

export type AgentSessionDto = {
  id: string;
  title: string;
  status: AgentSessionStatus;
  model: string;
  safetyMode: AgentSafetyMode;
  workspacePath: string;
  source: AgentSessionSource;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "failed";

export type AgentUsageDto = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AgentRunDto = {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  model: string;
  startedAt?: string;
  completedAt?: string;
  usage?: AgentUsageDto;
  error?: string;
};

type AgentItemBase = {
  id: string;
  sessionId: string;
  runId?: string;
  sequence: number;
  createdAt: string;
};

export type AgentMessageItemDto = AgentItemBase & {
  kind: "message";
  role: "user" | "assistant" | "system";
  text: string;
  status: "streaming" | "complete";
  attachments?: AgentArtifactDto[];
};

export type AgentReasoningItemDto = AgentItemBase & {
  kind: "reasoning";
  text: string;
  status: "streaming" | "complete";
};

export type AgentContextSummaryItemDto = AgentItemBase & {
  kind: "context_summary";
  text: string;
};

export type AgentToolCallItemDto = AgentItemBase & {
  kind: "tool_call";
  callId: string;
  name: string;
  arguments: unknown;
  status: "running" | "complete" | "failed";
};

export type AgentToolResultItemDto = AgentItemBase & {
  kind: "tool_result";
  callId: string;
  name: string;
  output: unknown;
  isError: boolean;
};

export type AgentInterruptionItemDto = AgentItemBase & {
  kind: "interruption";
  interruption: AgentInterruptionDto;
};

export type AgentErrorItemDto = AgentItemBase & {
  kind: "error";
  message: string;
  retryable: boolean;
};

export type AgentItemDto =
  | AgentMessageItemDto
  | AgentReasoningItemDto
  | AgentContextSummaryItemDto
  | AgentToolCallItemDto
  | AgentToolResultItemDto
  | AgentInterruptionItemDto
  | AgentErrorItemDto;

type AgentInterruptionBase = {
  id: string;
  sessionId: string;
  runId: string;
  status: "pending" | "resolved" | "expired";
  createdAt: string;
  resolvedAt?: string;
};

export type AgentApprovalInterruptionDto = AgentInterruptionBase & {
  kind: "approval";
  toolName: string;
  title: string;
  description: string;
  command?: string;
  allowAlways: boolean;
  resolution?: "once" | "session" | "always" | "deny";
};

export type AgentClarificationInterruptionDto = AgentInterruptionBase & {
  kind: "clarification";
  question: string;
  choices: string[];
  answer?: string;
};

export type AgentInterruptionDto = AgentApprovalInterruptionDto | AgentClarificationInterruptionDto;

export type AgentArtifactDto = {
  id: string;
  sessionId: string;
  runId?: string;
  itemId?: string;
  name: string;
  path: string;
  mimeType?: string;
  sizeBytes?: number;
  action: "created" | "updated" | "imported";
  available: boolean;
  createdAt: string;
};

export type AgentSkillDto = {
  id: string;
  name: string;
  description: string;
  source: "managed" | "user_global";
  enabled: boolean;
  editable: boolean;
};

type RuntimeFrameBase = {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  sessionId: string;
  runId: string;
  sequence: number;
};

export type AgentRuntimeEvent = RuntimeFrameBase &
  (
    | { eventId: string; method: "run.started"; data: { startedAt: string; model: string } }
    | {
        eventId: string;
        method: "message.delta";
        data: { itemId: string; role: "assistant"; delta: string; createdAt: string };
      }
    | {
        eventId: string;
        method: "message.completed";
        data: {
          itemId: string;
          role: "assistant";
          text: string;
          createdAt: string;
        };
      }
    | {
        eventId: string;
        method: "reasoning.delta";
        data: { itemId: string; delta: string; createdAt: string };
      }
    | {
        eventId: string;
        method: "tool.started";
        data: {
          itemId: string;
          callId: string;
          name: string;
          arguments: unknown;
          createdAt: string;
        };
      }
    | {
        eventId: string;
        method: "tool.completed";
        data: { itemId: string; callId: string; name: string; output: unknown; createdAt: string };
      }
    | {
        eventId: string;
        method: "tool.failed";
        data: { itemId: string; callId: string; name: string; error: string; createdAt: string };
      }
    | {
        eventId: string;
        method: "interruption.requested";
        data: { itemId: string; interruption: AgentInterruptionDto };
      }
    | { eventId: string; method: "usage.updated"; data: AgentUsageDto }
    | { eventId: string; method: "run.completed"; data: { completedAt: string } }
    | { eventId: string; method: "run.cancelled"; data: { completedAt: string } }
    | {
        eventId: string;
        method: "run.failed";
        data: { completedAt: string; message: string; retryable: boolean };
      }
  );

export type StartAgentRunRequest = {
  sessionId: string;
  prompt: string;
  model: string;
  safetyMode: AgentSafetyMode;
  workspacePath: string;
  enabledSkillIds: string[];
  attachments: string[];
};

export type ResolveAgentInterruptionRequest = {
  interruptionId: string;
  resolution:
    | { kind: "approval"; choice: "once" | "session" | "always" | "deny" }
    | { kind: "clarification"; answer: string };
};

/** Dependency-injected boundary implemented by the Tauri bindings. Keeping the
 * UI against this interface makes native command renames a single integration
 * change instead of another workspace-wide transport refactor. */
export type AgentRuntimeBindings = {
  listSessions(): Promise<AgentSessionDto[]>;
  getSession(sessionId: string): Promise<AgentSessionDto>;
  createSession(input: {
    title?: string;
    model: string;
    safetyMode: AgentSafetyMode;
  }): Promise<AgentSessionDto>;
  renameSession(sessionId: string, title: string): Promise<AgentSessionDto>;
  deleteSession(sessionId: string): Promise<void>;
  listItems(sessionId: string): Promise<AgentItemDto[]>;
  startRun(input: StartAgentRunRequest): Promise<AgentRunDto>;
  cancelRun(runId: string): Promise<void>;
  retryRun(runId: string): Promise<AgentRunDto>;
  resolveInterruption(input: ResolveAgentInterruptionRequest): Promise<AgentRunDto>;
  listArtifacts(sessionId: string): Promise<AgentArtifactDto[]>;
  listSkills(): Promise<AgentSkillDto[]>;
  setSkillEnabled(skillId: string, enabled: boolean): Promise<AgentSkillDto>;
};
