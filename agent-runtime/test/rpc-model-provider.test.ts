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
  choices: [{ index: 0, finish_reason: "stop", delta: { content: "from Clovy" } }],
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
  assert.deepEqual(textDeltas.map((event) => event.delta), ["Hello ", "from Clovy"]);
  assert.ok(events.some((event) => event.type === "response_done"));
});

test("retains the actual host route from the latest stream page", async () => {
  const provider = new RpcChatCompletionsModelProvider(async () => ({
    streamId: "stream-route",
    chunks: [finalChunk],
    done: true,
    route: {
      provider: "phala",
      privacyLevel: "tee",
      endpoint: "phala-glm-5.2",
    },
  }));
  for await (const _event of provider
    .getModel("private-auto")
    .getStreamedResponse(modelRequest())) {
    // Drain the model response.
  }
  assert.deepEqual(provider.latestRoute, {
    provider: "phala",
    privacyLevel: "tee",
    endpoint: "phala-glm-5.2",
  });
});

test("rejects an Auto response without a canonical selected model", async () => {
  const provider = new RpcChatCompletionsModelProvider(async () => ({
    streamId: "stream-auto-missing-model",
    chunks: [{ ...finalChunk, model: "open-software/auto" }],
    done: true,
  }));
  await assert.rejects(async () => {
    for await (const _event of provider
      .getModel("__june_auto_generation__:73")
      .getStreamedResponse(modelRequest())) {
      // Drain the model response.
    }
  }, /did not identify its selected model/);
});

test("captures Auto's canonical model from a later stream page", async () => {
  const requests: JsonObject[] = [];
  let page = 0;
  const provider = new RpcChatCompletionsModelProvider(async (input) => {
    if ("request" in input.arguments) requests.push(input.arguments.request);
    page += 1;
    if (page === 1) {
      return {
        streamId: "stream-auto-paged",
        chunks: [{ ...finalChunk, model: "open-software/auto" }],
        done: false,
        cursor: "page-2",
      };
    }
    return {
      streamId: "stream-auto-paged",
      chunks: [{ ...finalChunk, model: "z-ai/glm-5.2" }],
      done: true,
    };
  });
  for await (const _event of provider
    .getModel("__june_auto_generation__:73")
    .getStreamedResponse(modelRequest())) {
    // Drain the model response.
  }
  assert.equal(provider.resolvedModel, "z-ai/glm-5.2");
  assert.equal(requests.length, 1);
});

test("rejects conflicting canonical models in one Auto response", async () => {
  const provider = new RpcChatCompletionsModelProvider(async () => ({
    streamId: "stream-auto-conflict",
    chunks: [
      { ...finalChunk, model: "z-ai/glm-5.2" },
      { ...finalChunk, model: "kimi-k2" },
    ],
    done: true,
  }));
  await assert.rejects(async () => {
    for await (const _event of provider
      .getModel("__june_auto_generation__:73")
      .getStreamedResponse(modelRequest())) {
      // Drain the model response.
    }
  }, /conflicting selected models/);
});

test("rejects reserved internal tags as Auto's canonical model", async () => {
  const provider = new RpcChatCompletionsModelProvider(async () => ({
    streamId: "stream-auto-reserved",
    chunks: [
      { ...finalChunk, model: "__june_local_generation__:z-ai%2Fglm-5.2" },
      { ...finalChunk, model: "z-ai/glm-5.2" },
    ],
    done: true,
  }));
  await assert.rejects(async () => {
    for await (const _event of provider
      .getModel("__june_auto_generation__:73")
      .getStreamedResponse(modelRequest())) {
      // Drain the model response.
    }
  }, /invalid selected model/);
});

test("rejects non-string Auto model metadata before a later canonical model", async () => {
  const provider = new RpcChatCompletionsModelProvider(async () => ({
    streamId: "stream-auto-non-string",
    chunks: [
      { ...finalChunk, model: 42 },
      { ...finalChunk, model: "z-ai/glm-5.2" },
    ],
    done: true,
  }));
  await assert.rejects(async () => {
    for await (const _event of provider
      .getModel("__june_auto_generation__:73")
      .getStreamedResponse(modelRequest())) {
      // Drain the model response.
    }
  }, /invalid selected model/);
});

test("injects queued steering at the next model boundary and acknowledges consumption", async () => {
  const requests: JsonObject[] = [];
  const consumed: string[] = [];
  const steering = [{ messageId: "steer-1", text: "Prefer the launch plan" }];
  const provider = new RpcChatCompletionsModelProvider(
    async (input) => {
      if ("request" in input.arguments) requests.push(input.arguments.request);
      return { streamId: "stream-steer", chunks: [finalChunk], done: true };
    },
    {
      takeSteering: () => steering.splice(0),
      onSteeringConsumed: (message) => consumed.push(message.messageId),
    },
  );
  for await (const _event of provider.getModel("private-auto").getStreamedResponse(modelRequest())) {
    // Drain the model response.
  }
  const messages = requests[0]?.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.at(-1), { role: "user", content: "Prefer the launch plan" });
  assert.deepEqual(consumed, ["steer-1"]);
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

test("normalizes an empty streamed tool argument payload to an object", async () => {
  const provider = new RpcChatCompletionsModelProvider(async () => ({
    streamId: "stream-empty-tool-arguments",
    chunks: [
      {
        ...firstChunk,
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-empty",
                  type: "function",
                  function: { name: "increment", arguments: "" },
                },
              ],
            },
          },
        ],
      },
      {
        ...finalChunk,
        choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }],
      },
    ],
    done: true,
  }));
  const events = [];
  for await (const event of provider.getModel("private-auto").getStreamedResponse(modelRequest())) {
    events.push(event);
  }
  const done = events.find((event) => event.type === "response_done");
  const call = asRecord(done?.response.output[0]);
  assert.equal(call.type, "function_call");
  assert.equal(call.arguments, "{}");
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
