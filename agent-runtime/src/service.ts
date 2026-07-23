import { compactHistory } from "./compaction.js";
import { HOST_REQUEST_METHODS, ProtocolError, type RpcRequest, type RuntimeEventMethod } from "./protocol.js";
import { errorMessage, sanitizeForLog } from "./sanitize.js";
import type { NdjsonRpcPeer } from "./transport.js";
import type {
  AgentEngine,
  EngineEvent,
  EngineResult,
  JsonObject,
  JsonValue,
  RunResumeParams,
  RunStartParams,
  RuntimeInitializeParams,
  RuntimeUsage,
} from "./types.js";

type ActiveRun = { controller: AbortController };

export class RuntimeService {
  readonly engine: AgentEngine;
  peer?: NdjsonRpcPeer;
  initialized = false;
  shuttingDown = false;
  readonly activeRuns = new Map<string, ActiveRun>();

  constructor(engine: AgentEngine) {
    this.engine = engine;
  }

  attach(peer: NdjsonRpcPeer): void {
    this.peer = peer;
  }

  async handle(request: RpcRequest): Promise<JsonValue> {
    if (!HOST_REQUEST_METHODS.includes(request.method as (typeof HOST_REQUEST_METHODS)[number])) {
      throw new ProtocolError(-32601, `Unknown host method: ${request.method}`);
    }
    if (this.shuttingDown && request.method !== "runtime.shutdown") {
      throw new ProtocolError(-32003, "Runtime is shutting down");
    }
    switch (request.method) {
      case "runtime.initialize":
        return this.initialize(request.params);
      case "run.start":
        this.requireInitialized();
        return this.start(request.sessionId, request.runId, request.params);
      case "run.resume":
        this.requireInitialized();
        return this.resume(request.sessionId, request.runId, request.params);
      case "run.cancel":
        this.requireInitialized();
        return this.cancel(request.sessionId, request.runId);
      case "runtime.shutdown":
        return this.shutdown();
      default:
        throw new ProtocolError(-32601, `Unknown host method: ${request.method}`);
    }
  }

  private async initialize(params: JsonObject): Promise<JsonValue> {
    const parsed = params as RuntimeInitializeParams;
    if (typeof parsed.clientName !== "string" || typeof parsed.clientVersion !== "string") {
      throw new ProtocolError(-32602, "runtime.initialize requires clientName and clientVersion");
    }
    await this.engine.initialize(parsed);
    this.initialized = true;
    return {
      protocolVersion: 1,
      runtimeVersion: "0.1.0",
      rssBytes: process.memoryUsage().rss,
    };
  }

  private async start(sessionId: string, runId: string, params: JsonObject): Promise<JsonValue> {
    this.assertRunAvailable(sessionId, runId);
    const parsed = params as RunStartParams;
    validateRunStart(parsed);
    const compaction = await compactHistory({
      history: parsed.history,
      contextWindow: parsed.contextWindow,
      ...(parsed.maxOutputTokens === undefined ? {} : { maxOutputTokens: parsed.maxOutputTokens }),
    });
    const controller = new AbortController();
    this.activeRuns.set(runKey(sessionId, runId), { controller });
    this.emit("run.started", {
      model: parsed.model,
      compacted: compaction.compacted,
      history: compaction.history as unknown as JsonValue,
      removedItemIds: compaction.removedItemIds,
    }, sessionId, runId);
    const runParams: RunStartParams = { ...parsed, history: compaction.history };
    void this.settle(
      sessionId,
      runId,
      this.engine.start({
        sessionId,
        runId,
        params: runParams,
        signal: controller.signal,
        emit: (event) => this.forwardEngineEvent(event, sessionId, runId),
      }),
    );
    return { accepted: true, compacted: compaction.compacted };
  }

  private resume(sessionId: string, runId: string, params: JsonObject): JsonValue {
    this.assertRunAvailable(sessionId, runId);
    const parsed = params as RunResumeParams;
    if (typeof parsed.serializedState !== "string" || !Array.isArray(parsed.resolutions)) {
      throw new ProtocolError(-32602, "run.resume requires serializedState and resolutions");
    }
    const controller = new AbortController();
    this.activeRuns.set(runKey(sessionId, runId), { controller });
    this.emit("run.started", { resumed: true, model: parsed.model }, sessionId, runId);
    void this.settle(
      sessionId,
      runId,
      this.engine.resume({
        sessionId,
        runId,
        params: parsed,
        signal: controller.signal,
        emit: (event) => this.forwardEngineEvent(event, sessionId, runId),
      }),
    );
    return { accepted: true };
  }

  private cancel(sessionId: string, runId: string): JsonValue {
    const active = this.activeRuns.get(runKey(sessionId, runId));
    if (!active) return { cancelled: false, reason: "not_active" };
    active.controller.abort();
    return { cancelled: true };
  }

  private async shutdown(): Promise<JsonValue> {
    this.shuttingDown = true;
    for (const active of this.activeRuns.values()) active.controller.abort();
    await this.engine.shutdown();
    return { shutdown: true };
  }

  private async settle(sessionId: string, runId: string, resultPromise: Promise<EngineResult>): Promise<void> {
    try {
      const result = await resultPromise;
      if (result.interruptions.length > 0) {
        for (const interruption of result.interruptions) {
          this.emit("interruption.requested", {
            ...interruption,
            serializedState: result.serializedState ?? "",
          }, sessionId, runId);
        }
        this.emitUsage(result.usage, sessionId, runId);
        return;
      }
      if (this.activeRuns.get(runKey(sessionId, runId))?.controller.signal.aborted) {
        this.emit("run.cancelled", { history: result.history as unknown as JsonValue }, sessionId, runId);
        return;
      }
      if (result.finalOutput !== undefined) {
        this.emit("message.completed", { text: result.finalOutput }, sessionId, runId);
      }
      this.emitUsage(result.usage, sessionId, runId);
      this.emit("run.completed", { history: result.history as unknown as JsonValue }, sessionId, runId);
    } catch (error) {
      const active = this.activeRuns.get(runKey(sessionId, runId));
      if (active?.controller.signal.aborted || isAbortError(error)) {
        this.emit("run.cancelled", {}, sessionId, runId);
      } else {
        this.emit("run.failed", { error: errorMessage(error) }, sessionId, runId);
        void this.log("error", "Agent run failed", { error: sanitizeForLog(error) }, sessionId, runId);
      }
    } finally {
      this.activeRuns.delete(runKey(sessionId, runId));
    }
  }

  private forwardEngineEvent(event: EngineEvent, sessionId: string, runId: string): void {
    const { type, ...params } = event;
    this.emit(type, params as JsonObject, sessionId, runId);
  }

  private emitUsage(usage: RuntimeUsage, sessionId: string, runId: string): void {
    this.emit("usage.updated", usage as JsonObject, sessionId, runId);
  }

  private emit(method: RuntimeEventMethod, params: JsonObject, sessionId: string, runId: string): void {
    this.requirePeer().event(method, params, sessionId, runId);
  }

  private async log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data: JsonObject,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    try {
      await this.requirePeer().request("host.log", { level, message, data }, sessionId, runId);
    } catch {
      // Logging must never alter a run's outcome.
    }
  }

  private assertRunAvailable(sessionId: string, runId: string): void {
    if (this.activeRuns.has(runKey(sessionId, runId))) {
      throw new ProtocolError(-32002, "Run is already active");
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new ProtocolError(-32000, "Runtime is not initialized");
  }

  private requirePeer(): NdjsonRpcPeer {
    if (!this.peer) throw new ProtocolError(-32603, "Runtime transport is not attached");
    return this.peer;
  }
}

function validateRunStart(params: RunStartParams): void {
  if (
    typeof params.model !== "string" ||
    typeof params.input !== "string" ||
    typeof params.workspace !== "string" ||
    !Array.isArray(params.history) ||
    !Array.isArray(params.tools) ||
    !Number.isSafeInteger(params.contextWindow)
  ) {
    throw new ProtocolError(-32602, "Invalid run.start params");
  }
}

function runKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|cancelled/i.test(error.message));
}
