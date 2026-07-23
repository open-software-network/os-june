import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  encodeFrame,
  isRequest,
  isResponse,
  parseFrame,
  type RpcFailure,
  type RpcFrame,
  type RpcRequest,
  type RpcResponse,
  type RuntimeEventMethod,
  type RuntimeRequestMethod,
} from "./protocol.js";
import type { JsonObject, JsonValue } from "./types.js";

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

export type RequestHandler = (request: RpcRequest) => Promise<JsonValue>;

export class NdjsonRpcPeer {
  readonly input: Readable;
  readonly output: Writable;
  readonly handler: RequestHandler;
  readonly pending = new Map<string, PendingRequest>();
  readonly sequences = new Map<string, number>();
  closed = false;

  constructor(input: Readable, output: Writable, handler: RequestHandler) {
    this.input = input;
    this.output = output;
    this.handler = handler;
  }

  listen(): void {
    const lines = createInterface({ input: this.input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      void this.receive(line);
    });
    lines.on("close", () => this.close(new Error("Host transport closed")));
  }

  async request(
    method: RuntimeRequestMethod,
    params: JsonObject,
    sessionId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.closed) throw new Error("Runtime transport is closed");
    const id = crypto.randomUUID();
    const frame: RpcRequest = {
      jsonrpc: "2.0",
      protocolVersion: PROTOCOL_VERSION,
      id,
      method,
      params,
      sessionId,
      runId,
      sequence: this.nextSequence(sessionId, runId),
    };
    return new Promise<JsonValue>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          reject(abortError());
        },
        { once: true },
      );
      this.write(frame);
    });
  }

  event(
    method: RuntimeEventMethod,
    params: JsonObject,
    sessionId: string,
    runId: string,
  ): void {
    this.write({
      jsonrpc: "2.0",
      protocolVersion: PROTOCOL_VERSION,
      eventId: crypto.randomUUID(),
      method,
      params,
      sessionId,
      runId,
      sequence: this.nextSequence(sessionId, runId),
    });
  }

  close(reason = new Error("Runtime transport closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  private async receive(line: string): Promise<void> {
    let frame: RpcFrame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      const protocolError = error instanceof ProtocolError ? error : new ProtocolError(-32600, String(error));
      this.writeFailure("invalid-frame", "runtime", "runtime", protocolError);
      return;
    }
    if (isResponse(frame)) {
      this.resolveResponse(frame);
      return;
    }
    if (!isRequest(frame)) return;
    try {
      const result = await this.handler(frame);
      this.write({
        jsonrpc: "2.0",
        protocolVersion: PROTOCOL_VERSION,
        id: frame.id,
        result,
        sessionId: frame.sessionId,
        runId: frame.runId,
        sequence: this.nextSequence(frame.sessionId, frame.runId),
      });
    } catch (error) {
      const protocolError =
        error instanceof ProtocolError ? error : new ProtocolError(-32603, error instanceof Error ? error.message : String(error));
      this.writeFailure(frame.id, frame.sessionId, frame.runId, protocolError);
    }
  }

  private resolveResponse(frame: RpcResponse): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if ("error" in frame) pending.reject(new ProtocolError(frame.error.code, frame.error.message, frame.error.data));
    else pending.resolve(frame.result);
  }

  private writeFailure(id: string, sessionId: string, runId: string, error: ProtocolError): void {
    const frame: RpcFailure = {
      jsonrpc: "2.0",
      protocolVersion: PROTOCOL_VERSION,
      id,
      error: { code: error.code, message: error.message },
      sessionId,
      runId,
      sequence: this.nextSequence(sessionId, runId),
    };
    if (error.data !== undefined) frame.error.data = error.data;
    this.write(frame);
  }

  private write(frame: RpcFrame): void {
    this.output.write(encodeFrame(frame));
  }

  private nextSequence(sessionId: string, runId: string): number {
    const key = `${sessionId}\u0000${runId}`;
    const next = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, next);
    return next;
  }
}

function abortError(): Error {
  const error = new Error("Host request cancelled");
  error.name = "AbortError";
  return error;
}
