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
  estimatedTokens?: number;
};

export type RuntimeToolDescriptor = {
  name: string;
  description: string;
  parameters: JsonObject;
  requiresApproval?: boolean;
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
  instructions: string;
  workspace: string;
  safetyMode: SafetyMode;
  input: string;
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
    };

export type RunResumeParams = Omit<RunStartParams, "input" | "history"> & {
  serializedState: string;
  resolutions: InterruptionResolution[];
};

export type RuntimeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
};

export type RuntimeInterruption =
  | {
      id: string;
      kind: "approval";
      toolName: string;
      arguments: JsonValue;
    }
  | {
      id: string;
      kind: "clarification";
      toolName: "request_clarification";
      arguments: JsonValue;
      question: string;
      choices: string[];
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

export type EngineEvent =
  | { type: "message.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.started"; callId: string; name: string; arguments: JsonValue }
  | { type: "tool.completed"; callId: string; name: string; output: JsonValue }
  | { type: "tool.failed"; callId: string; name: string; error: string };

export type EngineRunInput = {
  sessionId: string;
  runId: string;
  params: RunStartParams;
  signal: AbortSignal;
  emit: (event: EngineEvent) => void;
};

export type EngineResumeInput = {
  sessionId: string;
  runId: string;
  params: RunResumeParams;
  signal: AbortSignal;
  emit: (event: EngineEvent) => void;
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
