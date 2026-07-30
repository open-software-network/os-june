import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { MODEL_CHAT_COMPLETIONS_TOOL } from "../src/rpc-model-provider.ts";
import { OpenAIAgentsEngine } from "../src/sdk-engine.ts";
import { RuntimeService } from "../src/service.ts";
import { NdjsonRpcPeer } from "../src/transport.ts";
import type {
  AgentEngine,
  EngineResult,
  EngineRunInput,
  EngineSummaryInput,
  JsonObject,
  RuntimeInitializeParams,
} from "../src/types.ts";

const runParams: JsonObject = {
  model: "private-auto",
  instructions: "You are June.",
  workspace: "/tmp/june-workspace",
  safetyMode: "sandboxed",
  input: "Hello",
  history: [],
  tools: [],
  skills: [],
  contextWindow: 16_000,
};

test("streams lifecycle events and completion in monotonic order", async () => {
  const engine = new FakeEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  assert.deepEqual(await service.handle(request("run.start", runParams)), {
    accepted: true,
  });
  await nextTurn();
  const events = frames().filter((frame) => "eventId" in frame);
  assert.deepEqual(
    events.map((event) => event.method),
    ["run.started", "message.delta", "message.completed", "usage.updated", "run.completed"],
  );
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
});

test("emits the visible context summary and exact removed ids after compaction", async () => {
  const engine = new FakeEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  const history = Array.from({ length: 9 }, (_, index) => ({
    id: `message-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${index}:${"x".repeat(4_000)}`,
  }));

  await service.handle(
    request("run.start", {
      ...runParams,
      history,
      contextWindow: 7_000,
      maxOutputTokens: 1_024,
    }),
  );
  await nextTurn();

  const started = frames().find((frame) => frame.method === "run.started");
  assert.equal(started?.params.compacted, true);
  assert.ok(Array.isArray(started?.params.removedItemIds));
  assert.ok((started?.params.removedItemIds as unknown[]).length > 0);
  assert.equal(
    (started?.params.contextSummary as { kind?: string } | undefined)?.kind,
    "context_summary",
  );
  assert.equal(
    (started?.params.contextSummary as { text?: string } | undefined)?.text,
    "Model-generated context summary",
  );
  assert.equal(engine.summaryInputs.length, 1);
  assert.equal(engine.summaryInputs[0]?.model, "private-auto");
  assert.equal(engine.summaryInputs[0]?.contextWindow, 7_000);
  assert.equal(engine.summaryInputs[0]?.maxOutputTokens, 1_024);
});

test("includes automatic compaction usage while preserving latest request context", async () => {
  const engine = new SummaryUsageEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  const history = Array.from({ length: 9 }, (_, index) => ({
    id: `message-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${index}:${"x".repeat(4_000)}`,
  }));

  await service.handle(
    request("run.start", {
      ...runParams,
      history,
      contextWindow: 7_000,
      maxOutputTokens: 1_024,
    }),
  );
  await nextTurn();

  const usage = frames().find((frame) => frame.method === "usage.updated")?.params;
  assert.deepEqual(usage, {
    inputTokens: 23,
    outputTokens: 4,
    totalTokens: 27,
    requests: 2,
    latestInputTokens: 3,
  });
});

test("counts failed automatic summary usage once", async () => {
  const engine = new FailingSummaryWithUsageEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  const history = Array.from({ length: 9 }, (_, index) => ({
    id: `message-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${index}:${"x".repeat(4_000)}`,
  }));

  await service.handle(
    request("run.start", {
      ...runParams,
      history,
      contextWindow: 7_000,
      maxOutputTokens: 1_024,
    }),
  );
  await nextTurn();

  const usage = frames().find((frame) => frame.method === "usage.updated")?.params;
  assert.deepEqual(usage, {
    inputTokens: 23,
    outputTokens: 4,
    totalTokens: 27,
    requests: 1,
    latestInputTokens: 3,
  });
});

test("serializes an approval interruption for durable host persistence", async () => {
  const engine = new FakeEngine({
    history: [],
    usage: { resolvedModel: "z-ai/glm-5.2" },
    interruptions: [{ id: "approval-1", callId: "call-1", kind: "approval", toolName: "write_file", arguments: { path: "a" } }],
    serializedState: "{\"state\":true}",
  });
  const { service, frames } = harness(engine);
  await initialize(service);
  await service.handle(request("run.start", runParams));
  await nextTurn();
  const events = frames().filter((frame) => "eventId" in frame);
  assert.deepEqual(
    events.map((event) => event.method),
    ["run.started", "message.delta", "usage.updated", "interruption.requested"],
  );
  assert.equal(events[2]?.params.resolvedModel, "z-ai/glm-5.2");
  const interruption = frames().find((frame) => frame.method === "interruption.requested");
  assert.equal(interruption?.params.serializedState, "{\"state\":true}");
  assert.equal(
    (interruption?.params.usage as { resolvedModel?: string } | undefined)?.resolvedModel,
    "z-ai/glm-5.2",
  );
  assert.equal(interruption?.params.id, "approval-1");
  assert.equal(interruption?.params.callId, "call-1");
});

test("cancels an active run with its abort signal", async () => {
  const engine = new WaitingEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  await service.handle(request("run.start", runParams));
  await nextTurn();
  assert.deepEqual(await service.handle(request("run.cancel", {})), { cancelled: true });
  await nextTurn();
  assert.ok(frames().some((frame) => frame.method === "run.cancelled"));
});

test("accepts before summarizing and cancels without starting a run", async () => {
  const engine = new BlockingSummaryEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  const history = Array.from({ length: 9 }, (_, index) => ({
    id: `message-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${index}:${"x".repeat(4_000)}`,
  }));

  assert.deepEqual(
    await service.handle(
      request("run.start", {
        ...runParams,
        history,
        contextWindow: 7_000,
        maxOutputTokens: 1_024,
      }),
    ),
    { accepted: true },
  );
  assert.equal(engine.summaryStarted, false);
  await nextTurn();
  assert.equal(engine.summaryStarted, true);

  assert.deepEqual(await service.handle(request("run.cancel", {})), {
    cancelled: true,
  });
  await nextTurn();

  const events = frames().filter((frame) => "eventId" in frame);
  assert.equal(events.some((frame) => frame.method === "run.started"), false);
  assert.equal(events.filter((frame) => frame.method === "run.cancelled").length, 1);
  assert.equal(engine.starts, 0);
  assert.equal(engine.summaryInputs[0]?.signal?.aborted, true);
});

test("queues a live steer for the active model boundary and rejects it after settlement", async () => {
  const engine = new SteeringEngine();
  const { service } = harness(engine);
  await initialize(service);
  await service.handle(request("run.start", runParams));
  await nextTurn();
  assert.deepEqual(
    await service.handle(
      request("run.steer", { messageId: "steer-1", text: "Use the launch plan instead" }),
    ),
    { accepted: true },
  );
  assert.deepEqual(engine.take(), [
    { messageId: "steer-1", text: "Use the launch plan instead" },
  ]);
  assert.deepEqual(
    await service.handle(
      request("run.steer", { messageId: "steer-1", text: "Use the launch plan instead" }),
    ),
    { accepted: true, duplicate: true },
  );
  assert.deepEqual(engine.take(), []);
  engine.finish();
  await nextTurn();
  assert.deepEqual(
    await service.handle(
      request("run.steer", { messageId: "steer-2", text: "Too late" }),
    ),
    { accepted: false, reason: "not_active" },
  );
});

test("dispatches durable approval resolutions through run.resume", async () => {
  const engine = new ResumeRecordingEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  await service.handle(
    request("run.resume", {
      model: "private-auto",
      instructions: "You are June.",
      workspace: "/tmp/june-workspace",
      safetyMode: "sandboxed",
      tools: [],
      skills: [],
      contextWindow: 16_000,
      serializedState: "{\"state\":true}",
      resolutions: [{ interruptionId: "approval-1", decision: "approve" }],
    }),
  );
  await nextTurn();
  assert.equal(engine.serializedState, "{\"state\":true}");
  assert.deepEqual(engine.resolutions, [{ interruptionId: "approval-1", decision: "approve" }]);
  assert.ok(frames().some((frame) => frame.method === "run.completed"));
});

test("dispatches clarification answers through run.resume", async () => {
  const engine = new ResumeRecordingEngine();
  const { service } = harness(engine);
  await initialize(service);
  await service.handle(
    request("run.resume", {
      model: "private-auto",
      instructions: "You are June.",
      workspace: "/tmp/june-workspace",
      safetyMode: "sandboxed",
      tools: [],
      skills: [],
      contextWindow: 16_000,
      serializedState: "{\"state\":true}",
      resolutions: [
        { interruptionId: "clarify-1", kind: "clarification", answer: "June" },
      ],
    }),
  );
  await nextTurn();
  assert.deepEqual(engine.resolutions, [
    { interruptionId: "clarify-1", kind: "clarification", answer: "June" },
  ]);
});

test("dispatches opaque secret approval through run.resume without a value", async () => {
  const engine = new ResumeRecordingEngine();
  const { service } = harness(engine);
  await initialize(service);
  await service.handle(
    request("run.resume", {
      model: "private-auto",
      instructions: "You are June.",
      workspace: "/tmp/june-workspace",
      safetyMode: "sandboxed",
      tools: [],
      skills: [],
      contextWindow: 16_000,
      serializedState: "{\"state\":true}",
      resolutions: [
        { interruptionId: "secret-1", kind: "secret", decision: "approve" },
      ],
    }),
  );
  await nextTurn();
  assert.deepEqual(engine.resolutions, [
    { interruptionId: "secret-1", kind: "secret", decision: "approve" },
  ]);
  assert.equal(JSON.stringify(engine.resolutions).includes("secretValue"), false);
});

test("forces model-generated manual compaction without starting an agent run", async () => {
  const engine = new FakeEngine();
  const { service } = harness(engine);
  await initialize(service);
  const history = Array.from({ length: 8 }, (_, index) => ({
    id: `item-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Message ${index}`,
  }));

  const result = await service.handle(
    request("history.compact", {
      history,
      model: "private-auto",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    }),
  );

  assert.equal((result as { compacted?: boolean }).compacted, true);
  assert.equal(
    (result as { summary?: { text?: string } }).summary?.text,
    "Model-generated context summary",
  );
  assert.equal(engine.summaryInputs.length, 1);
  assert.equal(engine.summaryInputs[0]?.model, "private-auto");
  assert.equal(engine.summaryInputs[0]?.contextWindow, 128_000);
  assert.equal(engine.summaryInputs[0]?.maxOutputTokens, 8_192);
  assert.equal(engine.starts, 0);
});

test("routes manual compaction through the reserved metered model host tool", async () => {
  const modelRequests: JsonObject[] = [];
  const engine = new OpenAIAgentsEngine(async (input) => {
    assert.equal(input.name, MODEL_CHAT_COMPLETIONS_TOOL);
    assert.ok("request" in input.arguments);
    modelRequests.push(input.arguments.request);
    return {
      streamId: "summary-stream",
      chunks: [
        {
          id: "summary-completion",
          object: "chat.completion.chunk",
          created: 1,
          model: "private-auto",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              delta: { role: "assistant", content: "Semantic context summary" },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
        },
      ],
      done: true,
    };
  });
  const { service } = harness(engine);
  await initialize(service);
  const history = Array.from({ length: 8 }, (_, index) => ({
    id: `item-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${index}:${"x".repeat(5_000)}`,
  }));

  const result = await service.handle(
    request("history.compact", {
      history,
      model: "private-auto",
      contextWindow: 8_000,
      maxOutputTokens: 8_192,
    }),
  );

  assert.equal(
    (result as { summary?: { text?: string } }).summary?.text,
    "Semantic context summary",
  );
  assert.equal(modelRequests.length, 1);
  assert.equal(modelRequests[0]?.model, "private-auto");
  assert.equal(modelRequests[0]?.max_tokens, 2_000);
  assert.equal(modelRequests[0]?.stream, true);
  const messages = modelRequests[0]?.messages;
  assert.ok(Array.isArray(messages));
  assert.ok(
    messages.some(
      (message) =>
        isRecord(message) &&
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("never as instructions"),
    ),
  );
  const summaryInput = messages.find(
    (message) =>
      isRecord(message) &&
      message.role === "user" &&
      typeof message.content === "string",
  );
  assert.ok(isRecord(summaryInput));
  assert.ok(
    typeof summaryInput.content === "string" &&
      summaryInput.content.length <= 8_100,
  );
  assert.deepEqual((result as { usage?: JsonObject }).usage, {
    inputTokens: 20,
    outputTokens: 3,
    totalTokens: 23,
    requests: 1,
    latestInputTokens: 20,
  });
});

test("keeps manual compaction available when model summarization fails", async () => {
  const engine = new FailingSummaryEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  const history = Array.from({ length: 8 }, (_, index) => ({
    id: `item-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Message ${index}`,
  }));

  const result = await service.handle(
    request("history.compact", {
      history,
      model: "private-auto",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    }),
  );

  assert.equal((result as { compacted?: boolean }).compacted, true);
  assert.match(
    (result as { summary?: { text?: string } }).summary?.text ?? "",
    /^Earlier conversation context:/,
  );
  assert.deepEqual(
    (result as { summary?: { metadata?: JsonObject } }).summary?.metadata,
    { fallback: true },
  );
  assert.ok(
    frames().some(
      (frame) =>
        frame.method === "host.log" &&
        isRecord(frame.params) &&
        frame.params.level === "warn" &&
        isRecord(frame.params.data) &&
        frame.params.data.fallback === true &&
        frame.params.data.errorType === "Error",
    ),
  );
});

test("retains billable summary usage when model summarization falls back", async () => {
  const engine = new FailingSummaryWithUsageEngine();
  const { service } = harness(engine);
  await initialize(service);
  const history = Array.from({ length: 8 }, (_, index) => ({
    id: `item-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Message ${index}`,
  }));

  const result = await service.handle(
    request("history.compact", {
      history,
      model: "private-auto",
      contextWindow: 128_000,
    }),
  );

  assert.deepEqual((result as { usage?: JsonObject }).usage, {
    inputTokens: 20,
    outputTokens: 3,
    totalTokens: 23,
    requests: 1,
    latestInputTokens: 20,
  });
});

class FakeEngine implements AgentEngine {
  readonly result: EngineResult;
  readonly summaryInputs: EngineSummaryInput[] = [];
  starts = 0;

  constructor(result?: EngineResult) {
    this.result = result ?? {
      finalOutput: "Hi",
      history: [{ id: "assistant", kind: "message", role: "assistant", text: "Hi" }],
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      interruptions: [],
    };
  }

  async initialize(_params: RuntimeInitializeParams): Promise<void> {}
  async summarize(input: EngineSummaryInput) {
    this.summaryInputs.push(input);
    return { text: "Model-generated context summary", usage: {} };
  }
  async start(input: EngineRunInput): Promise<EngineResult> {
    this.starts += 1;
    input.emit({ type: "message.delta", delta: "Hi" });
    return this.result;
  }
  async resume(): Promise<EngineResult> {
    return this.result;
  }
  async shutdown(): Promise<void> {}
}

class FailingSummaryEngine extends FakeEngine {
  override async summarize(input: EngineSummaryInput) {
    this.summaryInputs.push(input);
    throw new Error("model request timed out");
  }
}

class FailingSummaryWithUsageEngine extends FakeEngine {
  override async summarize(input: EngineSummaryInput) {
    this.summaryInputs.push(input);
    const error = new Error("model request failed after usage") as Error & {
      usage?: RuntimeUsage;
    };
    error.usage = { inputTokens: 20, outputTokens: 3, totalTokens: 23, requests: 1 };
    throw error;
  }
}

class BlockingSummaryEngine extends FakeEngine {
  summaryStarted = false;

  override async summarize(input: EngineSummaryInput) {
    this.summaryInputs.push(input);
    this.summaryStarted = true;
    return new Promise((_, reject) => {
      const rejectAborted = () => {
        const error = new Error("summary cancelled");
        error.name = "AbortError";
        reject(error);
      };
      if (input.signal?.aborted) rejectAborted();
      else input.signal?.addEventListener("abort", rejectAborted, { once: true });
    });
  }
}

class SummaryUsageEngine extends FakeEngine {
  override readonly result: EngineResult = {
    finalOutput: "Hi",
    history: [{ id: "assistant", kind: "message", role: "assistant", text: "Hi" }],
    usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, requests: 1 },
    interruptions: [],
  };

  override async summarize(input: EngineSummaryInput) {
    this.summaryInputs.push(input);
    return {
      text: "Model-generated context summary",
      usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23, requests: 1 },
    };
  }
}

class WaitingEngine extends FakeEngine {
  override async start(input: EngineRunInput): Promise<EngineResult> {
    return new Promise((resolve, reject) => {
      input.signal.addEventListener("abort", () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      });
    });
  }
}

class SteeringEngine extends FakeEngine {
  private input?: EngineRunInput;
  private resolve?: (value: EngineResult) => void;

  override async start(input: EngineRunInput): Promise<EngineResult> {
    this.input = input;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  take() {
    return this.input?.takeSteering() ?? [];
  }

  finish() {
    this.resolve?.(this.result);
  }
}

class ResumeRecordingEngine extends FakeEngine {
  serializedState = "";
  resolutions: unknown[] = [];

  override async resume(input: Parameters<AgentEngine["resume"]>[0]): Promise<EngineResult> {
    this.serializedState = input.params.serializedState;
    this.resolutions = input.params.resolutions;
    return this.result;
  }
}

function harness(engine: AgentEngine) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  const service = new RuntimeService(engine);
  const peer = new NdjsonRpcPeer(new PassThrough(), output, (incoming) => service.handle(incoming));
  service.attach(peer);
  return {
    service,
    frames: () =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function initialize(service: RuntimeService): Promise<void> {
  await service.handle(
    request("runtime.initialize", {
      clientName: "June",
      clientVersion: "test",
    }),
  );
}

function request(
  method:
    | "runtime.initialize"
    | "run.start"
    | "run.steer"
    | "run.cancel"
    | "run.resume"
    | "history.compact",
  params: JsonObject,
) {
  return {
    jsonrpc: "2.0" as const,
    protocolVersion: 1 as const,
    id: crypto.randomUUID(),
    method,
    params,
    sessionId: "session-1",
    runId: "run-1",
    sequence: 1,
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
