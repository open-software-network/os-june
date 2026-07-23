import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest } from "@openai/agents";
import {
  MODEL_CHAT_COMPLETIONS_TOOL,
  RpcChatCompletionsModelProvider,
} from "../src/rpc-model-provider.ts";
import type { JsonObject } from "../src/types.ts";

const firstChunk: JsonObject = {
  id: "completion-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "private-auto",
  choices: [
    {
      index: 0,
      finish_reason: null,
      delta: { role: "assistant", content: "Hello " },
    },
  ],
};

const finalChunk: JsonObject = {
  id: "completion-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "private-auto",
  choices: [{ index: 0, finish_reason: "stop", delta: { content: "from June" } }],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
};

test("routes a model request through the reserved host tool without HTTP", async () => {
  const calls: Array<{ name: string; arguments: JsonObject }> = [];
  const provider = new RpcChatCompletionsModelProvider(async (input) => {
    calls.push({ name: input.name, arguments: input.arguments });
    if ("request" in input.arguments) {
      return { streamId: "stream-1", chunks: [firstChunk], done: false };
    }
    return { streamId: input.arguments.streamId, chunks: [finalChunk], done: true };
  });
  const events = [];
  for await (const event of provider.getModel("private-auto").getStreamedResponse(modelRequest())) {
    events.push(event);
  }
  assert.equal(calls[0]?.name, MODEL_CHAT_COMPLETIONS_TOOL);
  assert.equal(asRecord(calls[0]?.arguments.request).model, "private-auto");
  assert.equal(asRecord(calls[0]?.arguments.request).stream, true);
  assert.deepEqual(calls[1]?.arguments, { streamId: "stream-1" });
  assert.ok(events.some((event) => event.type === "response_done"));
});

test("emits each polled model chunk before the stream completes", async () => {
  let call = 0;
  const provider = new RpcChatCompletionsModelProvider(async () => {
    call += 1;
    return call === 1
      ? { streamId: "stream-1", chunks: [firstChunk], done: false }
      : { streamId: "stream-1", chunks: [finalChunk], done: true };
  });
  const iterator = provider.getModel("private-auto").getStreamedResponse(modelRequest())[Symbol.asyncIterator]();
  const events = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === "output_text_delta") break;
  }
  assert.equal(call, 1, "the first text delta must be visible before the cursor poll");
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  const textDeltas = events.filter((event) => event.type === "output_text_delta");
  assert.deepEqual(textDeltas.map((event) => event.delta), ["Hello ", "from June"]);
  assert.ok(events.some((event) => event.type === "response_done"));
});

test("preserves function tool calls when synthesizing a stream", async () => {
  const provider = new RpcChatCompletionsModelProvider(async () => ({
    streamId: "stream-tools",
    chunks: [
      {
        ...firstChunk,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "search_notes", arguments: "{\"query\":\"launch\"}" },
                },
              ],
            },
          },
        ],
      },
    ],
    done: true,
  }));
  const events = [];
  for await (const event of provider.getModel("private-auto").getStreamedResponse(modelRequest())) {
    events.push(event);
  }
  const done = events.find((event) => event.type === "response_done");
  assert.equal(done?.response.output[0]?.type, "function_call");
});

function modelRequest(): ModelRequest {
  return {
    input: [{ role: "user", content: "Say hello" }],
    modelSettings: {},
    tools: [],
    outputType: "text",
    handoffs: [],
    tracing: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
