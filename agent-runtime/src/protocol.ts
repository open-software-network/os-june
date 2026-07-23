import type { JsonObject, JsonValue } from "./types.js";

export const PROTOCOL_VERSION = 1 as const;

export const HOST_REQUEST_METHODS = [
  "runtime.initialize",
  "run.start",
  "run.cancel",
  "run.resume",
  "runtime.shutdown",
] as const;

export const RUNTIME_REQUEST_METHODS = ["tool.invoke", "host.log"] as const;

export const RUNTIME_EVENT_METHODS = [
  "run.started",
  "message.delta",
  "message.completed",
  "reasoning.delta",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "interruption.requested",
  "usage.updated",
  "run.completed",
  "run.cancelled",
  "run.failed",
] as const;

export type HostRequestMethod = (typeof HOST_REQUEST_METHODS)[number];
export type RuntimeRequestMethod = (typeof RUNTIME_REQUEST_METHODS)[number];
export type RuntimeEventMethod = (typeof RUNTIME_EVENT_METHODS)[number];

type FrameBase = {
  jsonrpc: "2.0";
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  runId: string;
  sequence: number;
};

export type RpcRequest = FrameBase & {
  id: string;
  method: HostRequestMethod | RuntimeRequestMethod;
  params: JsonObject;
};

export type RpcSuccess = FrameBase & {
  id: string;
  result: JsonValue;
};

export type RpcFailure = FrameBase & {
  id: string;
  error: { code: number; message: string; data?: JsonValue };
};

export type RpcResponse = RpcSuccess | RpcFailure;

export type RuntimeEvent = FrameBase & {
  eventId: string;
  method: RuntimeEventMethod;
  params: JsonObject;
};

export type RpcFrame = RpcRequest | RpcResponse | RuntimeEvent;

export class ProtocolError extends Error {
  readonly code: number;
  readonly data?: JsonValue;

  constructor(code: number, message: string, data?: JsonValue) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function parseFrame(line: string): RpcFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError(-32700, "Invalid JSON");
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new ProtocolError(-32600, "Invalid JSON-RPC frame");
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      -32001,
      `Unsupported protocol version: ${String(value.protocolVersion)}`,
    );
  }
  requireString(value, "sessionId");
  requireString(value, "runId");
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) {
    throw new ProtocolError(-32600, "Frame sequence must be a non-negative integer");
  }
  if ("method" in value) {
    requireString(value, "method");
    if ("eventId" in value) {
      requireString(value, "eventId");
    } else {
      requireString(value, "id");
    }
    if (!isRecord(value.params)) {
      throw new ProtocolError(-32602, "Frame params must be an object");
    }
  } else {
    requireString(value, "id");
    if (!("result" in value) && !("error" in value)) {
      throw new ProtocolError(-32600, "Response must contain result or error");
    }
  }
  return value as RpcFrame;
}

export function encodeFrame(frame: RpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function isRequest(frame: RpcFrame): frame is RpcRequest {
  return "method" in frame && !("eventId" in frame);
}

export function isResponse(frame: RpcFrame): frame is RpcResponse {
  return !("method" in frame);
}

export function isEvent(frame: RpcFrame): frame is RuntimeEvent {
  return "method" in frame && "eventId" in frame;
}

function requireString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "string" || value[key] === "") {
    throw new ProtocolError(-32600, `Frame ${key} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
