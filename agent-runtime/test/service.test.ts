import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { RuntimeService } from "../src/service.ts";
import { NdjsonRpcPeer } from "../src/transport.ts";
import type {
  AgentEngine,
  EngineResult,
  EngineRunInput,
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
  assert.deepEqual(await service.handle(request("run.start", runParams)), { accepted: true, compacted: false });
  await nextTurn();
  const events = frames().filter((frame) => "eventId" in frame);
  assert.deepEqual(
    events.map((event) => event.method),
    ["run.started", "message.delta", "message.completed", "usage.updated", "run.completed"],
  );
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
});

test("serializes an approval interruption for durable host persistence", async () => {
  const engine = new FakeEngine({
    history: [],
    usage: {},
    interruptions: [{ id: "approval-1", kind: "approval", toolName: "write_file", arguments: { path: "a" } }],
    serializedState: "{\"state\":true}",
  });
  const { service, frames } = harness(engine);
  await initialize(service);
  await service.handle(request("run.start", runParams));
  await nextTurn();
  const interruption = frames().find((frame) => frame.method === "interruption.requested");
  assert.equal(interruption?.params.serializedState, "{\"state\":true}");
  assert.equal(interruption?.params.id, "approval-1");
});

test("cancels an active run with its abort signal", async () => {
  const engine = new WaitingEngine();
  const { service, frames } = harness(engine);
  await initialize(service);
  await service.handle(request("run.start", runParams));
  assert.deepEqual(await service.handle(request("run.cancel", {})), { cancelled: true });
  await nextTurn();
  assert.ok(frames().some((frame) => frame.method === "run.cancelled"));
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

class FakeEngine implements AgentEngine {
  readonly result: EngineResult;

  constructor(result?: EngineResult) {
    this.result = result ?? {
      finalOutput: "Hi",
      history: [{ id: "assistant", kind: "message", role: "assistant", text: "Hi" }],
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      interruptions: [],
    };
  }

  async initialize(_params: RuntimeInitializeParams): Promise<void> {}
  async start(input: EngineRunInput): Promise<EngineResult> {
    input.emit({ type: "message.delta", delta: "Hi" });
    return this.result;
  }
  async resume(): Promise<EngineResult> {
    return this.result;
  }
  async shutdown(): Promise<void> {}
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

function request(method: "runtime.initialize" | "run.start" | "run.cancel" | "run.resume", params: JsonObject) {
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
