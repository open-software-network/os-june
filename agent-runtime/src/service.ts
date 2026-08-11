import { compactHistory } from "./compaction.js";
import { clovyIdentityResult } from "./identity.js";
import { HOST_REQUEST_METHODS, ProtocolError, type RpcRequest, type RuntimeEventMethod } from "./protocol.js";
import { errorMessage, runtimeFailureDetails, sanitizeForLog } from "./sanitize.js";
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

type ActiveRun = {
  controller: AbortController;
  steering: { messageId: string; text: string }[];
  steeringIds: Set<string>;
};

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
      case "run.steer":
        this.requireInitialized();
        return this.steer(request.sessionId, request.runId, request.params);
      case "run.cancel":
        this.requireInitialized();
        return this.cancel(request.sessionId, request.runId);
      case "history.compact":
        this.requireInitialized();
        return this.compact(request.sessionId, request.runId, request.params);
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

  private start(sessionId: string, runId: string, params: JsonObject): JsonValue {
    this.assertRunAvailable(sessionId, runId);
    const parsed = params as RunStartParams;
    validateRunStart(parsed);
    const controller = new AbortController();
    const active: ActiveRun = { controller, steering: [], steeringIds: new Set() };
    this.activeRuns.set(runKey(sessionId, runId), active);
    setImmediate(() => {
      void this.settle(
        sessionId,
        runId,
        this.startAcceptedRun(sessionId, runId, parsed, active),
      );
    });
    return { accepted: true };
  }

  private async startAcceptedRun(
    sessionId: string,
    runId: string,
    parsed: RunStartParams,
    active: ActiveRun,
  ): Promise<EngineResult> {
    throwIfAborted(active.controller.signal);
    const identityResult = clovyIdentityResult(parsed);
    if (identityResult) {
      this.emit("run.started", {
        model: parsed.model,
        compacted: false,
        history: parsed.history as unknown as JsonValue,
        removedItemIds: [],
      }, sessionId, runId);
      this.emit("message.delta", { delta: identityResult.finalOutput ?? "" }, sessionId, runId);
      return identityResult;
    }
    const compaction = await compactHistory({
      history: parsed.history,
      contextWindow: parsed.contextWindow,
      ...(parsed.maxOutputTokens === undefined ? {} : { maxOutputTokens: parsed.maxOutputTokens }),
      onFallback: (error) =>
        this.logCompactionFallback(error, sessionId, runId),
      summarize: (history) =>
        this.engine.summarize({
          sessionId,
          runId,
          model: parsed.model,
          history,
          contextWindow: parsed.contextWindow,
          ...(parsed.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: parsed.maxOutputTokens }),
          signal: active.controller.signal,
        }),
    });
    throwIfAborted(active.controller.signal);
    this.emit("run.started", {
      model: parsed.model,
      compacted: compaction.compacted,
      history: compaction.history as unknown as JsonValue,
      removedItemIds: compaction.removedItemIds,
      ...(compaction.summary === undefined
        ? {}
        : { contextSummary: compaction.summary as unknown as JsonValue }),
    }, sessionId, runId);
    const runParams: RunStartParams = { ...parsed, history: compaction.history };
    return this.engine.start({
      sessionId,
      runId,
      params: runParams,
      signal: active.controller.signal,
      emit: (event) => this.forwardEngineEvent(event, sessionId, runId),
      takeSteering: () => active.steering.splice(0),
    });
  }

  private resume(sessionId: string, runId: string, params: JsonObject): JsonValue {
    this.assertRunAvailable(sessionId, runId);
    const parsed = params as RunResumeParams;
    if (typeof parsed.serializedState !== "string" || !Array.isArray(parsed.resolutions)) {
      throw new ProtocolError(-32602, "run.resume requires serializedState and resolutions");
    }
    const controller = new AbortController();
    const active: ActiveRun = { controller, steering: [], steeringIds: new Set() };
    this.activeRuns.set(runKey(sessionId, runId), active);
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
        takeSteering: () => active.steering.splice(0),
      }),
    );
    return { accepted: true };
  }

  private steer(sessionId: string, runId: string, params: JsonObject): JsonValue {
    const active = this.activeRuns.get(runKey(sessionId, runId));
    if (!active) return { accepted: false, reason: "not_active" };
    const text = typeof params.text === "string" ? params.text.trim() : "";
    const messageId = typeof params.messageId === "string" ? params.messageId.trim() : "";
    if (!text || !messageId) {
      throw new ProtocolError(-32602, "run.steer requires text and messageId");
    }
    if (active.steeringIds.has(messageId)) {
      return { accepted: true, duplicate: true };
    }
    active.steeringIds.add(messageId);
    active.steering.push({ messageId, text });
    return { accepted: true };
  }

  private cancel(sessionId: string, runId: string): JsonValue {
    const active = this.activeRuns.get(runKey(sessionId, runId));
    if (!active) return { cancelled: false, reason: "not_active" };
    active.controller.abort();
    return { cancelled: true };
  }

  private async compact(
    sessionId: string,
    runId: string,
    params: JsonObject,
  ): Promise<JsonValue> {
    const history = params.history;
    if (!Array.isArray(history)) {
      throw new ProtocolError(-32602, "history.compact requires history");
    }
    const model = typeof params.model === "string" ? params.model.trim() : "";
    const maxOutputTokens =
      typeof params.maxOutputTokens === "number" ? params.maxOutputTokens : undefined;
    const result = await compactHistory({
      history: history as RunStartParams["history"],
      contextWindow:
        typeof params.contextWindow === "number" ? params.contextWindow : 128_000,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      onFallback: (error) =>
        this.logCompactionFallback(error, sessionId, runId),
      ...(model
        ? {
            summarize: (items) =>
              this.engine.summarize({
                sessionId,
                runId,
                model,
                history: items,
                contextWindow:
                  typeof params.contextWindow === "number"
                    ? params.contextWindow
                    : 128_000,
                ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
              }),
          }
        : {}),
      force: true,
    });
    return result as unknown as JsonValue;
  }

  private logCompactionFallback(
    error: unknown,
    sessionId: string,
    runId: string,
  ): void {
    void this.log(
      "warn",
      "Model context summary failed; using deterministic fallback",
      {
        error: errorMessage(error),
        errorType: error instanceof Error ? error.name : typeof error,
        fallback: true,
      },
      sessionId,
      runId,
    );
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
      if (this.activeRuns.get(runKey(sessionId, runId))?.controller.signal.aborted) {
        this.emit("run.cancelled", { history: result.history as unknown as JsonValue }, sessionId, runId);
        return;
      }
      if (result.interruptions.length > 0) {
        // Persist the concrete model before exposing an interruption so a
        // resumed Auto run keeps the model selected for this agent run.
        this.emitUsage(result.usage, sessionId, runId);
        for (const interruption of result.interruptions) {
          this.emit("interruption.requested", {
            ...interruption,
            serializedState: result.serializedState ?? "",
            usage: result.usage as unknown as JsonValue,
          }, sessionId, runId);
        }
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
        const failure = runtimeFailureDetails(error);
        this.emit(
          "run.failed",
          {
            error: failure.message,
            category: failure.category,
            code: failure.code,
            retryable: failure.retryable,
          },
          sessionId,
          runId,
        );
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Agent run cancelled");
  error.name = "AbortError";
  throw error;
}
