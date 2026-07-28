import {
  OpenAIChatCompletionsModel,
  type Model,
  type ModelProvider,
} from "@openai/agents";
import type { JsonObject, JsonValue, ModelRoute } from "./types.js";
import type { SteeringMessage } from "./types.js";

export const MODEL_CHAT_COMPLETIONS_TOOL = "__june_model_chat_completions";

export type ModelRpcInvoker = (input: {
  name: typeof MODEL_CHAT_COMPLETIONS_TOOL;
  arguments: { request: JsonObject } | { streamId: string };
  callId: string;
  signal?: AbortSignal;
}) => Promise<JsonValue>;

export class RpcChatCompletionsModelProvider implements ModelProvider {
  readonly invoke: ModelRpcInvoker;
  readonly takeSteering: (() => SteeringMessage[]) | undefined;
  readonly onSteeringConsumed: ((message: SteeringMessage) => void) | undefined;
  latestRoute: ModelRoute | undefined;

  constructor(
    invoke: ModelRpcInvoker,
    steering?: {
      takeSteering: () => SteeringMessage[];
      onSteeringConsumed: (message: SteeringMessage) => void;
    },
    initialRoute?: ModelRoute,
  ) {
    this.invoke = invoke;
    this.takeSteering = steering?.takeSteering;
    this.onSteeringConsumed = steering?.onSteeringConsumed;
    this.latestRoute = initialRoute;
  }

  getModel(modelName?: string): Model {
    if (!modelName) throw new Error("A model name is required for June model routing");
    const client = {
      baseURL: "stdio://june-host",
      chat: {
        completions: {
          create: async (body: unknown, options?: { signal?: AbortSignal }) => {
            const wantsStream = asRecord(body).stream === true;
            const request = asJsonObject({
              ...asRecord(body),
              stream: true,
              stream_options: { include_usage: true },
            });
            const chunks = this.streamChunks(request, options?.signal);
            if (wantsStream) return chunks;
            return collectChatCompletion(chunks);
          },
        },
      },
    };
    return new OpenAIChatCompletionsModel(
      client as unknown as ConstructorParameters<typeof OpenAIChatCompletionsModel>[0],
      modelName,
      { strictFeatureValidation: true },
    );
  }

  private async *streamChunks(request: JsonObject, signal?: AbortSignal): AsyncIterable<JsonObject> {
    const steering = this.takeSteering?.() ?? [];
    if (steering.length > 0) {
      const messages = Array.isArray(request.messages) ? request.messages : [];
      request.messages = [
        ...messages,
        ...steering.map((message) => ({ role: "user", content: message.text })),
      ];
      for (const message of steering) this.onSteeringConsumed?.(message);
    }
    normalizeOutgoingReasoning(request, this.latestRoute);
    const toolArgumentState = new Map<string, boolean>();
    let page = requireStreamPage(
      await this.invoke({
        name: MODEL_CHAT_COMPLETIONS_TOOL,
        arguments: { request },
        callId: crypto.randomUUID(),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    while (true) {
      if (page.route) this.latestRoute = page.route;
      for (const chunk of page.chunks) {
        yield normalizeEmptyToolArguments(normalizeReasoningContent(chunk), toolArgumentState);
      }
      if (page.done) return;
      page = requireStreamPage(
        await this.invoke({
          name: MODEL_CHAT_COMPLETIONS_TOOL,
          arguments: { streamId: page.streamId },
          callId: crypto.randomUUID(),
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    }
  }
}

function normalizeEmptyToolArguments(
  chunk: JsonObject,
  state: Map<string, boolean>,
): JsonObject {
  if (!Array.isArray(chunk.choices)) return chunk;
  let changed = false;
  const choices = chunk.choices.map((choiceValue) => {
    if (!isRecord(choiceValue)) return choiceValue;
    const choiceIndex = numberValue(choiceValue.index) ?? 0;
    const delta = asRecord(choiceValue.delta);
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const toolValue of toolCalls) {
      const toolCall = asRecord(toolValue);
      const toolIndex = numberValue(toolCall.index) ?? 0;
      const key = `${choiceIndex}:${toolIndex}`;
      if (!state.has(key)) state.set(key, false);
      const argumentsChunk = asRecord(toolCall.function).arguments;
      if (typeof argumentsChunk === "string" && argumentsChunk.trim() !== "") {
        state.set(key, true);
      }
    }
    if (choiceValue.finish_reason !== "tool_calls") return choiceValue;

    const missing = [...state.entries()]
      .filter(([key, hasArguments]) => key.startsWith(`${choiceIndex}:`) && !hasArguments)
      .map(([key]) => Number(key.slice(key.indexOf(":") + 1)));
    if (missing.length === 0) return choiceValue;

    changed = true;
    const missingSet = new Set(missing);
    const patched = new Set<number>();
    const normalizedToolCalls = toolCalls.map((toolValue) => {
      if (!isRecord(toolValue)) return toolValue;
      const toolIndex = numberValue(toolValue.index) ?? 0;
      if (!missingSet.has(toolIndex)) return toolValue;
      patched.add(toolIndex);
      return {
        ...toolValue,
        function: { ...asRecord(toolValue.function), arguments: "{}" },
      };
    });
    for (const toolIndex of missing) {
      if (!patched.has(toolIndex)) {
        normalizedToolCalls.push({ index: toolIndex, function: { arguments: "{}" } });
      }
      state.set(`${choiceIndex}:${toolIndex}`, true);
    }
    return {
      ...choiceValue,
      delta: { ...delta, tool_calls: normalizedToolCalls },
    };
  });
  return changed ? { ...chunk, choices } : chunk;
}

// Maps `delta.reasoning_content` → `delta.reasoning` so the OpenAI Agents SDK
// (which only reads `reasoning`) captures reasoning that GLM/Z.AI streams
// under the provider-native `reasoning_content` field. When both fields are
// present, `reasoning_content` wins (it is the provider-native field) and
// `reasoning` is replaced. Safe for all models: a model that does not emit
// `reasoning_content` is untouched.
function normalizeReasoningContent(chunk: JsonObject): JsonObject {
  if (!Array.isArray(chunk.choices)) return chunk;
  let changed = false;
  const choices = chunk.choices.map((choiceValue) => {
    if (!isRecord(choiceValue)) return choiceValue;
    const delta = asRecord(choiceValue.delta);
    if (typeof delta.reasoning_content !== "string") return choiceValue;
    changed = true;
    const rest: Record<string, unknown> = { ...delta };
    delete rest.reasoning_content;
    return { ...choiceValue, delta: { ...rest, reasoning: delta.reasoning_content } };
  });
  return changed ? { ...chunk, choices } : chunk;
}

// Known GLM model IDs that require `reasoning_content` (not `reasoning`) on
// assistant tool-call replay. Auto (`open-software/auto`) is not included
// because it dynamically resolves to GLM only at the routing layer; the
// route-endpoint check below covers that case for live tool loops.
const GLM_MODEL_IDS = new Set([
  "zai-org-glm-5-2",
  "zai-org-glm-5-1",
  "zai-org-glm-5",
  "z-ai/glm-5.2",
]);

// Route endpoint pattern for GLM upstreams (e.g. `phala-glm-5.2`).
const GLM_ENDPOINT_PATTERN = /-glm-\d/i;

// Renames `assistant.reasoning` → `assistant.reasoning_content` on outgoing
// requests to GLM/Z.AI models. The SDK replays reasoning as `reasoning`, but
// GLM expects its native `reasoning_content` field. Idempotent: messages that
// already carry `reasoning_content` are left alone. Only applies when the
// route endpoint or model ID is a known GLM identifier.
function normalizeOutgoingReasoning(request: JsonObject, route: ModelRoute | undefined): void {
  if (!isGlmRoute(route, request.model)) return;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (message.reasoning_content !== undefined) continue;
    if (typeof message.reasoning === "string" && message.reasoning !== "") {
      message.reasoning_content = message.reasoning;
      delete message.reasoning;
    }
  }
}

function isGlmRoute(route: ModelRoute | undefined, model: unknown): boolean {
  if (typeof route?.endpoint === "string" && GLM_ENDPOINT_PATTERN.test(route.endpoint)) return true;
  if (typeof model === "string" && GLM_MODEL_IDS.has(model)) return true;
  return false;
}

type StreamPage = { streamId: string; chunks: JsonObject[]; done: boolean; route?: ModelRoute };

function requireStreamPage(value: JsonValue): StreamPage {
  if (!isRecord(value) || typeof value.streamId !== "string" || !Array.isArray(value.chunks) || typeof value.done !== "boolean") {
    throw new Error("June model host returned an invalid Chat Completions stream page");
  }
  const chunks = value.chunks.map((chunk) => {
    if (!isRecord(chunk)) throw new Error("June model host returned a non-object stream chunk");
    return chunk;
  });
  const routeValue = isRecord(value.route) ? value.route : undefined;
  const provider = stringValue(routeValue?.provider);
  const privacyLevel = stringValue(routeValue?.privacyLevel);
  const endpoint = stringValue(routeValue?.endpoint);
  const route = routeValue
    ? {
        ...(provider ? { provider } : {}),
        ...(privacyLevel ? { privacyLevel } : {}),
        ...(endpoint ? { endpoint } : {}),
      }
    : undefined;
  return { streamId: value.streamId, chunks, done: value.done, ...(route ? { route } : {}) };
}

async function collectChatCompletion(chunks: AsyncIterable<JsonObject>): Promise<JsonObject> {
  let id = `june-${crypto.randomUUID()}`;
  let created = Math.floor(Date.now() / 1_000);
  let model = "june-routed-model";
  let usage: JsonValue | undefined;
  const choices = new Map<number, {
    content: string;
    reasoning: string;
    refusal: string;
    finishReason: JsonValue;
    toolCalls: Map<number, { id: string; type: string; name: string; arguments: string }>;
  }>();
  for await (const chunk of chunks) {
    id = stringValue(chunk.id) ?? id;
    created = numberValue(chunk.created) ?? created;
    model = stringValue(chunk.model) ?? model;
    if (chunk.usage !== undefined) usage = chunk.usage;
    for (const choiceValue of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const choice = asRecord(choiceValue);
      const index = numberValue(choice.index) ?? 0;
      const current = choices.get(index) ?? {
        content: "",
        reasoning: "",
        refusal: "",
        finishReason: null,
        toolCalls: new Map(),
      };
      const delta = asRecord(choice.delta);
      if (typeof delta.content === "string") current.content += delta.content;
      if (typeof delta.reasoning === "string") current.reasoning += delta.reasoning;
      else if (typeof delta.reasoning_content === "string") current.reasoning += delta.reasoning_content;
      if (typeof delta.refusal === "string") current.refusal += delta.refusal;
      if (typeof choice.finish_reason === "string") current.finishReason = choice.finish_reason;
      for (const toolValue of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const tool = asRecord(toolValue);
        const toolIndex = numberValue(tool.index) ?? 0;
        const existing = current.toolCalls.get(toolIndex) ?? { id: "", type: "function", name: "", arguments: "" };
        const fn = asRecord(tool.function);
        if (typeof tool.id === "string") existing.id = tool.id;
        if (typeof tool.type === "string") existing.type = tool.type;
        if (typeof fn.name === "string") existing.name += fn.name;
        if (typeof fn.arguments === "string") existing.arguments += fn.arguments;
        current.toolCalls.set(toolIndex, existing);
      }
      choices.set(index, current);
    }
  }
  return asJsonObject({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [...choices.entries()].map(([index, choice]) => ({
      index,
      finish_reason: choice.finishReason,
      message: compactObject({
        role: "assistant",
        content: choice.content || null,
        reasoning: choice.reasoning || undefined,
        refusal: choice.refusal || undefined,
        tool_calls: choice.toolCalls.size
          ? [...choice.toolCalls.entries()].map(([, toolCall]) => ({
              id: toolCall.id,
              type: toolCall.type,
              function: { name: toolCall.name, arguments: toolCall.arguments },
            }))
          : undefined,
      }),
    })),
    ...(usage === undefined ? {} : { usage }),
  });
}

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
