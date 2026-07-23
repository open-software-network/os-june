import {
  Agent,
  RunState,
  Runner,
  setTracingDisabled,
  tool,
  type FunctionTool,
} from "@openai/agents";
import { RpcChatCompletionsModelProvider } from "./rpc-model-provider.js";
import { REQUEST_CLARIFICATION_TOOL } from "./types.js";
import type { JsonObject, JsonValue } from "./types.js";
import { errorMessage, sanitizeForLog } from "./sanitize.js";
import type {
  AgentEngine,
  EngineEvent,
  EngineResult,
  EngineResumeInput,
  EngineRunInput,
  HostToolInvoker,
  RunResumeParams,
  RunStartParams,
  RuntimeHistoryItem,
  RuntimeInitializeParams,
  RuntimeInterruption,
  RuntimeToolDescriptor,
  RuntimeUsage,
} from "./types.js";

type SdkStream = AsyncIterable<unknown> & {
  completed: Promise<void>;
  cancelled: boolean;
  error?: unknown;
  interruptions: unknown[];
  state: { toString(): string };
  history: unknown;
  finalOutput: unknown;
  usage: unknown;
};

export class OpenAIAgentsEngine implements AgentEngine {
  readonly invokeHostTool: HostToolInvoker;
  initialized = false;

  constructor(invokeHostTool: HostToolInvoker) {
    this.invokeHostTool = invokeHostTool;
  }

  async initialize(_params: RuntimeInitializeParams): Promise<void> {
    setTracingDisabled(true);
    this.initialized = true;
  }

  async start(input: EngineRunInput): Promise<EngineResult> {
    const agent = this.createAgent(input.params, input.sessionId, input.runId, input.emit);
    const sdkInput = [...historyToSdkInput(input.params.history), userMessage(input.params.input)];
    const stream = (await this.createRunner(input.sessionId, input.runId).run(agent, sdkInput as never, {
      stream: true,
      signal: input.signal,
      maxTurns: 40,
    })) as unknown as SdkStream;
    return this.consumeStream(stream, input.params.history, input.emit);
  }

  async resume(input: EngineResumeInput): Promise<EngineResult> {
    const agent = this.createAgent(input.params, input.sessionId, input.runId, input.emit);
    const state = await RunState.fromString(agent, input.params.serializedState);
    const interruptions = state.getInterruptions();
    for (const resolution of input.params.resolutions) {
      const interruption = interruptions.find((candidate) => interruptionId(candidate) === resolution.interruptionId);
      if (!interruption) throw new Error(`Unknown interruption: ${resolution.interruptionId}`);
      if (resolution.kind === "clarification" || resolution.decision === "approve") {
        state.approve(interruption);
      } else {
        state.reject(interruption, resolution.message ? { message: resolution.message } : undefined);
      }
    }
    const stream = (await this.createRunner(input.sessionId, input.runId).run(agent, state, {
      stream: true,
      signal: input.signal,
      maxTurns: 40,
    })) as unknown as SdkStream;
    return this.consumeStream(stream, [], input.emit);
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  private createAgent(
    params: RunStartParams | RunResumeParams,
    sessionId: string,
    runId: string,
    emit: (event: EngineEvent) => void,
  ): Agent {
    const descriptors = params.tools.some((descriptor) => descriptor.name === REQUEST_CLARIFICATION_TOOL.name)
      ? params.tools
      : [...params.tools, REQUEST_CLARIFICATION_TOOL];
    const tools = descriptors.map((descriptor) =>
      this.createTool(descriptor, sessionId, runId, emit),
    );
    const skillCatalog = params.skills.length
      ? `\n\nAvailable skills (load instructions with load_skill when needed):\n${params.skills
          .map((skill) => `- ${skill.name}: ${skill.description}`)
          .join("\n")}`
      : "";
    return new Agent({
      name: "June",
      instructions: `${params.instructions}${skillCatalog}`,
      model: params.model,
      tools,
    });
  }

  private createTool(
    descriptor: RuntimeToolDescriptor,
    sessionId: string,
    runId: string,
    emit: (event: EngineEvent) => void,
  ): FunctionTool {
    return tool({
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters as never,
      strict: true,
      needsApproval: descriptor.requiresApproval ?? false,
      execute: async (argumentsValue, _context, details) => {
        const callId = toolCallId(details);
        const argumentsJson = asJsonValue(argumentsValue);
        emit({
          type: "tool.started",
          callId,
          name: descriptor.name,
          arguments: sanitizeForLog(argumentsJson),
        });
        try {
          const output = await this.invokeHostTool({
            sessionId,
            runId,
            name: descriptor.name,
            arguments: argumentsJson,
            callId,
          });
          emit({ type: "tool.completed", callId, name: descriptor.name, output: sanitizeForLog(output) });
          return output;
        } catch (error) {
          const message = errorMessage(error);
          emit({ type: "tool.failed", callId, name: descriptor.name, error: message });
          throw new Error(message);
        }
      },
    });
  }

  private async consumeStream(
    stream: SdkStream,
    _priorHistory: RuntimeHistoryItem[],
    emit: (event: EngineEvent) => void,
  ): Promise<EngineResult> {
    for await (const event of stream) this.forwardSdkEvent(event, emit);
    await stream.completed;
    if (stream.cancelled) throw abortError();
    if (stream.error) throw stream.error;

    const interruptions = stream.interruptions.map(runtimeInterruptionFromSdk);
    const serializedState = interruptions.length > 0 ? stream.state.toString() : undefined;
    const history = sdkHistoryToRuntime(stream.history);
    return {
      ...(typeof stream.finalOutput === "string" ? { finalOutput: stream.finalOutput } : {}),
      history,
      usage: normalizeUsage(stream.usage),
      interruptions,
      ...(serializedState === undefined ? {} : { serializedState }),
    };
  }

  private forwardSdkEvent(event: unknown, emit: (event: EngineEvent) => void): void {
    if (!isRecord(event) || event.type !== "raw_model_stream_event" || !isRecord(event.data)) return;
    const type = String(event.data.type ?? "");
    const delta = typeof event.data.delta === "string" ? event.data.delta : undefined;
    if (!delta) return;
    if (type.includes("reasoning") && isDeltaEvent(type)) {
      emit({ type: "reasoning.delta", delta });
    } else if (type.includes("output_text") && isDeltaEvent(type)) {
      emit({ type: "message.delta", delta });
    }
  }

  private createRunner(sessionId: string, runId: string): Runner {
    if (!this.initialized) throw new Error("OpenAI Agents engine is not initialized");
    const modelProvider = new RpcChatCompletionsModelProvider(async (request) =>
      this.invokeHostTool({
        sessionId,
        runId,
        name: request.name,
        arguments: request.arguments,
        callId: request.callId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
    );
    return new Runner({
      modelProvider,
      tracingDisabled: true,
      toolNotFoundBehavior: "return_error_to_model",
      toolExecution: { maxFunctionToolConcurrency: 4, preApprovalInputGuardrails: true },
    });
  }
}

function historyToSdkInput(history: RuntimeHistoryItem[]): unknown[] {
  return history.flatMap((item) => {
    if (item.payload !== undefined) return [item.payload];
    if (item.kind !== "message" && item.kind !== "context_summary") return [];
    const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
    return [{ role, content: item.text ?? "" }];
  });
}

function userMessage(text: string): unknown {
  return { role: "user", content: text };
}

function sdkHistoryToRuntime(history: unknown): RuntimeHistoryItem[] {
  if (!Array.isArray(history)) return [];
  return history.flatMap<RuntimeHistoryItem>((item, index): RuntimeHistoryItem[] => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === "string" ? item.id : `sdk-history-${index}-${crypto.randomUUID()}`;
    const payload = asJsonValue(item);
    if (typeof item.role === "string") {
      const text = extractText(item.content);
      const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : item.role === "tool" ? "tool" : "user";
      return [{ id, kind: "message", role, text, payload } satisfies RuntimeHistoryItem];
    }
    const itemType = String(item.type ?? "");
    const callId = stringValue(item.callId ?? item.call_id);
    const kind = itemType.includes("reasoning")
      ? "reasoning"
      : itemType.includes("output") || itemType.includes("result")
        ? "tool_result"
        : itemType.includes("call")
          ? "tool_call"
          : undefined;
    if (!kind) return [];
    return [{
      id,
      kind,
      ...(callId ? { callId, groupId: callId } : {}),
      payload,
    } satisfies RuntimeHistoryItem];
  });
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

export function runtimeInterruptionFromSdk(interruption: unknown): RuntimeInterruption {
  const record = isRecord(interruption) ? interruption : {};
  const toolName = typeof record.name === "string" ? record.name : "unknown_tool";
  const argumentsValue = parsedToolArguments(record.arguments);
  if (toolName === REQUEST_CLARIFICATION_TOOL.name) {
    const argumentsRecord = isRecord(argumentsValue) ? argumentsValue : {};
    return {
      id: interruptionId(interruption),
      kind: "clarification",
      toolName: "request_clarification",
      arguments: argumentsValue,
      question:
        typeof argumentsRecord.question === "string"
          ? argumentsRecord.question
          : "What would you like June to do?",
      choices: Array.isArray(argumentsRecord.choices)
        ? argumentsRecord.choices.filter((choice): choice is string => typeof choice === "string")
        : [],
    };
  }
  return {
    id: interruptionId(interruption),
    kind: "approval",
    toolName,
    arguments: argumentsValue,
  };
}

function parsedToolArguments(value: unknown): JsonValue {
  if (typeof value === "string") {
    try {
      return sanitizeForLog(JSON.parse(value));
    } catch {
      return sanitizeForLog(value);
    }
  }
  return sanitizeForLog(value);
}

function interruptionId(interruption: unknown): string {
  if (!isRecord(interruption)) return "unknown-interruption";
  if (typeof interruption.id === "string") return interruption.id;
  if (typeof interruption.callId === "string") return interruption.callId;
  if (isRecord(interruption.rawItem) && typeof interruption.rawItem.callId === "string") {
    return interruption.rawItem.callId;
  }
  return "unknown-interruption";
}

function toolCallId(details: unknown): string {
  if (isRecord(details)) {
    if (typeof details.toolCallId === "string") return details.toolCallId;
    if (typeof details.callId === "string") return details.callId;
  }
  return crypto.randomUUID();
}

function normalizeUsage(usage: unknown): RuntimeUsage {
  if (!isRecord(usage)) return {};
  return compactObject({
    inputTokens: numberValue(usage.inputTokens ?? usage.input_tokens),
    outputTokens: numberValue(usage.outputTokens ?? usage.output_tokens),
    totalTokens: numberValue(usage.totalTokens ?? usage.total_tokens),
    requests: numberValue(usage.requests),
  });
}

function compactObject(value: Record<string, number | undefined>): RuntimeUsage {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => entry[1] !== undefined));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  return sanitizeForLog(value);
}

function asJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error("Agent run cancelled");
  error.name = "AbortError";
  return error;
}

function isDeltaEvent(type: string): boolean {
  return type.endsWith(".delta") || type.endsWith("_delta");
}
