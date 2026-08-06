export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SafetyMode = "sandboxed" | "unrestricted";

export type RuntimeHistoryItem = {
  id: string;
  kind: "message" | "reasoning" | "tool_call" | "tool_result" | "context_summary";
  role?: "system" | "user" | "assistant" | "tool";
  text?: string;
  name?: string;
  callId?: string;
  groupId?: string;
  payload?: JsonValue;
  metadata?: JsonObject;
  attachments?: RuntimeAttachmentDescriptor[];
  estimatedTokens?: number;
};

export type RuntimeAttachmentDescriptor = {
  path: string;
  mimeType?: string;
};

export type RuntimeToolDescriptor = {
  name: string;
  description: string;
  parameters: JsonObject;
  strict?: boolean;
  requiresApproval?: boolean;
  approvalProvider?: string;
  approvalRemoteToolName?: string;
  policyFingerprint?: string;
  notionAction?: boolean;
};

export type RuntimeSkillDescriptor = {
  name: string;
  description: string;
  source: "managed" | "external";
};

export type RuntimeInitializeParams = {
  clientName: string;
  clientVersion: string;
};

export type RunStartParams = {
  model: string;
  reasoningEffort?: "minimal" | "medium" | "high";
  instructions: string;
  workspace: string;
  safetyMode: SafetyMode;
  input: string;
  attachments?: RuntimeAttachmentDescriptor[];
  history: RuntimeHistoryItem[];
  tools: RuntimeToolDescriptor[];
  skills: RuntimeSkillDescriptor[];
  contextWindow: number;
  maxOutputTokens?: number;
};

export type InterruptionResolution =
  | {
      interruptionId: string;
      kind?: "approval";
      decision: "approve" | "reject";
      message?: string;
    }
  | {
      interruptionId: string;
      kind: "clarification";
      answer: string;
    }
  | {
      interruptionId: string;
      kind: "secret";
      decision: "approve" | "reject";
    };

export type RunResumeParams = Omit<RunStartParams, "input" | "history"> & {
  serializedState: string;
  resolutions: InterruptionResolution[];
  resolvedModel?: string;
};

export type RuntimeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
  provider?: string;
  privacyLevel?: string;
  endpoint?: string;
  resolvedModel?: string;
};

export type RuntimeInterruption =
  | {
      id: string;
      callId: string;
      kind: "approval";
      toolName: string;
      arguments: JsonValue;
      approvalProvider?: string;
      approvalRemoteToolName?: string;
      approvalPresentation?: {
        title: string;
        description: string;
        command: string;
        preview: string;
      };
      approvalBinding?: {
        digest: string;
      };
    }
  | {
      id: string;
      kind: "clarification";
      toolName: "request_clarification";
      arguments: JsonValue;
      question: string;
      choices: string[];
    }
  | {
      id: string;
      kind: "secret";
      toolName: "request_secret";
      arguments: JsonValue;
      reason: string;
    };

export const REQUEST_CLARIFICATION_TOOL: RuntimeToolDescriptor = {
  name: "request_clarification",
  description: "Ask the user a blocking clarification question before continuing.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
      choices: { type: "array", items: { type: "string" } },
    },
    required: ["question"],
    additionalProperties: false,
  },
  requiresApproval: true,
};

export const REQUEST_SECRET_TOOL: RuntimeToolDescriptor = {
  name: "request_secret",
  description:
    "Securely ask the user for a secret required by a tool. The value is delivered through Clovy's keychain boundary and is never added to model context.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string" },
    },
    required: ["reason"],
    additionalProperties: false,
  },
  requiresApproval: true,
};

export type EngineEvent =
  | { type: "message.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "steering.consumed"; messageId: string; text: string }
  | { type: "tool.started"; callId: string; name: string; arguments: JsonValue }
  | { type: "tool.completed"; callId: string; name: string; output: JsonValue }
  | { type: "tool.failed"; callId: string; name: string; error: string };

export type EngineRunInput = {
  sessionId: string;
  runId: string;
  params: RunStartParams;
  signal: AbortSignal;
  emit: (event: EngineEvent) => void;
  takeSteering: () => SteeringMessage[];
};

export type EngineResumeInput = {
  sessionId: string;
  runId: string;
  params: RunResumeParams;
  signal: AbortSignal;
  emit: (event: EngineEvent) => void;
  takeSteering: () => SteeringMessage[];
};

export type EngineSummaryInput = {
  sessionId: string;
  runId: string;
  model: string;
  history: RuntimeHistoryItem[];
  contextWindow: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type SteeringMessage = {
  messageId: string;
  text: string;
};

export type EngineResult = {
  finalOutput?: string;
  history: RuntimeHistoryItem[];
  usage: RuntimeUsage;
  interruptions: RuntimeInterruption[];
  serializedState?: string;
};

export interface AgentEngine {
  initialize(params: RuntimeInitializeParams): Promise<void>;
  summarize(input: EngineSummaryInput): Promise<string>;
  start(input: EngineRunInput): Promise<EngineResult>;
  resume(input: EngineResumeInput): Promise<EngineResult>;
  shutdown(): Promise<void>;
}

export type HostToolInvoker = (input: {
  sessionId: string;
  runId: string;
  name: string;
  arguments: JsonValue;
  callId: string;
  signal?: AbortSignal;
}) => Promise<JsonValue>;
