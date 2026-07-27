import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, ProtocolError, encodeFrame, parseFrame } from "../src/protocol.ts";

test("round trips a versioned request frame", () => {
  const frame = {
    jsonrpc: "2.0" as const,
    protocolVersion: PROTOCOL_VERSION,
    id: "request-1",
    method: "run.cancel" as const,
    params: {},
    sessionId: "session-1",
    runId: "run-1",
    sequence: 7,
  };
  assert.deepEqual(parseFrame(encodeFrame(frame).trim()), frame);
});

test("rejects unknown protocol versions before dispatch", () => {
  assert.throws(
    () =>
      parseFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          protocolVersion: 2,
          id: "request-1",
          method: "run.cancel",
          params: {},
          sessionId: "session-1",
          runId: "run-1",
          sequence: 1,
        }),
      ),
    (error: unknown) => error instanceof ProtocolError && error.code === -32001,
  );
});

test("rejects malformed JSON and invalid sequences", () => {
  assert.throws(() => parseFrame("{"), /Invalid JSON/);
  assert.throws(
    () =>
      parseFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          protocolVersion: 1,
          id: "request-1",
          method: "run.cancel",
          params: {},
          sessionId: "session-1",
          runId: "run-1",
          sequence: -1,
        }),
      ),
    /non-negative integer/,
  );
});
