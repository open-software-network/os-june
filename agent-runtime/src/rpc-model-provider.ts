import {
  OpenAIChatCompletionsModel,
  type Model,
  type ModelProvider,
} from "@openai/agents";
import type { JsonObject, JsonValue } from "./types.js";

export const MODEL_CHAT_COMPLETIONS_TOOL = "__june_model_chat_completions";

export type ModelRpcInvoker = (input: {
  name: typeof MODEL_CHAT_COMPLETIONS_TOOL;
  arguments: { request: JsonObject } | { streamId: string };
  callId: string;
  signal?: AbortSignal;
}) => Promise<JsonValue>;

export class RpcChatCompletionsModelProvider implements ModelProvider {
  readonly invoke: ModelRpcInvoker;

  constructor(invoke: ModelRpcInvoker) {
    this.invoke = invoke;
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
    let page = requireStreamPage(
      await this.invoke({
        name: MODEL_CHAT_COMPLETIONS_TOOL,
        arguments: { request },
        callId: crypto.randomUUID(),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    while (true) {
      for (const chunk of page.chunks) yield chunk;
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

type StreamPage = { streamId: string; chunks: JsonObject[]; done: boolean };

function requireStreamPage(value: JsonValue): StreamPage {
  if (!isRecord(value) || typeof value.streamId !== "string" || !Array.isArray(value.chunks) || typeof value.done !== "boolean") {
    throw new Error("June model host returned an invalid Chat Completions stream page");
  }
  const chunks = value.chunks.map((chunk) => {
    if (!isRecord(chunk)) throw new Error("June model host returned a non-object stream chunk");
    return chunk;
  });
  return { streamId: value.streamId, chunks, done: value.done };
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
