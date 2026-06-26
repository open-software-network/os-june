import { describe, expect, it } from "vitest";
import {
  buildHermesDashboardArgs,
  buildRpcFrame,
  buildStatusUrl,
  buildWsUrl,
  generateSessionToken,
  isControlledModelDispatchError,
  parseReadinessBody,
  parseRpcFrame,
  resolveHermesCommand,
} from "../lib/hermes-smoke/helpers";

// These helpers MUST mirror what `src-tauri/src/hermes_bridge.rs` does on the
// Rust side so the smoke script launches and talks to Hermes exactly like June
// does. The assertions below are pinned to that behavior, not to convenience.

describe("generateSessionToken — matches random_token()", () => {
  it("produces a 43-char alphanumeric token (Rust take(43) Alphanumeric)", () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9]{43}$/);
  });

  it("is different on each call", () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });
});

describe("buildWsUrl — matches the ws_url format in start_hermes_bridge_inner", () => {
  it("builds ws://host:port/api/ws?token=<urlencoded>", () => {
    expect(buildWsUrl("127.0.0.1", 51234, "abc123")).toBe(
      "ws://127.0.0.1:51234/api/ws?token=abc123",
    );
  });

  it("url-encodes the token (urlencoding::encode on the Rust side)", () => {
    // A token with reserved characters must be percent-encoded so the query
    // string June actually sends is well-formed.
    expect(buildWsUrl("127.0.0.1", 8080, "a b/c?d=e&f")).toBe(
      "ws://127.0.0.1:8080/api/ws?token=a%20b%2Fc%3Fd%3De%26f",
    );
  });
});

describe("buildStatusUrl — matches the readiness probe in wait_for_hermes", () => {
  it("builds http://host:port/api/status", () => {
    expect(buildStatusUrl("127.0.0.1", 51234)).toBe(
      "http://127.0.0.1:51234/api/status",
    );
  });
});

describe("buildHermesDashboardArgs — matches the hermes_args array", () => {
  it("emits dashboard --no-open --host <host> --port <port>", () => {
    expect(buildHermesDashboardArgs("127.0.0.1", 51234)).toEqual([
      "dashboard",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "51234",
    ]);
  });
});

describe("buildRpcFrame — matches HermesGatewayClient.request wire frame", () => {
  it("builds a JSON-RPC 2.0 request frame with id, method, params", () => {
    expect(
      buildRpcFrame(1, "session.create", { title: "Smoke", cols: 96 }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session.create",
      params: { title: "Smoke", cols: 96 },
    });
  });

  it("defaults params to an empty object (session.active_list sends {})", () => {
    expect(buildRpcFrame(7, "session.active_list")).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "session.active_list",
      params: {},
    });
  });
});

describe("parseReadinessBody — mirrors the /api/status gateway_running read", () => {
  it("reports gatewayRunning true when the flag is set", () => {
    const parsed = parseReadinessBody('{"gateway_running":true}');
    expect(parsed.ok).toBe(true);
    expect(parsed.gatewayRunning).toBe(true);
  });

  it("reports gatewayRunning false when absent (start_hermes_gateway_if_needed)", () => {
    const parsed = parseReadinessBody("{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.gatewayRunning).toBe(false);
  });

  it("does not throw on non-JSON; reports not-ok", () => {
    const parsed = parseReadinessBody("<html>502</html>");
    expect(parsed.ok).toBe(false);
    expect(parsed.gatewayRunning).toBe(false);
  });
});

describe("isControlledModelDispatchError — gates the /model smoke PASS", () => {
  it("treats a Hermes application code (4018 not-a-command) as controlled", () => {
    // The real controlled response to a bare /model dispatch.
    expect(isControlledModelDispatchError({ code: 4018 })).toBe(true);
  });

  it("treats 4009 session-busy as controlled", () => {
    expect(isControlledModelDispatchError({ code: 4009 })).toBe(true);
  });

  it("rejects a JSON-RPC protocol error (-32601 method-not-found)", () => {
    // A vanished/renamed method is a real regression, not a controlled PASS.
    expect(isControlledModelDispatchError({ code: -32601 })).toBe(false);
  });

  it("rejects a rejection with no code", () => {
    expect(isControlledModelDispatchError(new Error("connection closed"))).toBe(
      false,
    );
    expect(isControlledModelDispatchError({})).toBe(false);
  });

  it("rejects a non-numeric code", () => {
    expect(isControlledModelDispatchError({ code: "4018" })).toBe(false);
    expect(isControlledModelDispatchError({ code: null })).toBe(false);
  });

  it("does not throw on null/undefined input", () => {
    expect(isControlledModelDispatchError(null)).toBe(false);
    expect(isControlledModelDispatchError(undefined)).toBe(false);
  });
});

describe("parseRpcFrame — mirrors HermesGatewayClient.handleMessage", () => {
  it("parses a successful response keyed by id", () => {
    const frame = parseRpcFrame(
      JSON.stringify({ jsonrpc: "2.0", id: 3, result: { session_id: "s1" } }),
    );
    expect(frame).toEqual({
      kind: "result",
      id: 3,
      result: { session_id: "s1" },
    });
  });

  it("parses an error response carrying the JSON-RPC code (e.g. 4009)", () => {
    const frame = parseRpcFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        error: { code: 4009, message: "session busy" },
      }),
    );
    expect(frame).toEqual({
      kind: "error",
      id: 4,
      code: 4009,
      message: "session busy",
    });
  });

  it("parses an event notification ({method:'event', params:{type}})", () => {
    const frame = parseRpcFrame(
      JSON.stringify({
        method: "event",
        params: { type: "gateway.ready" },
      }),
    );
    expect(frame).toEqual({
      kind: "event",
      type: "gateway.ready",
      params: { type: "gateway.ready" },
    });
  });

  it("returns kind 'ignore' for unparseable frames (handleMessage swallows)", () => {
    expect(parseRpcFrame("not json").kind).toBe("ignore");
  });
});

describe("resolveHermesCommand — mirrors resolve_hermes_command discovery", () => {
  it("honors SCRIBE_HERMES_COMMAND when it points at an existing file", () => {
    // Use this very test file as a stand-in for an existing executable path.
    const self = new URL(import.meta.url).pathname;
    const resolved = resolveHermesCommand({
      env: { SCRIBE_HERMES_COMMAND: self },
      fileExists: (p) => p === self,
    });
    expect(resolved).toEqual({ command: self, source: "env_override" });
  });

  it("trims and ignores a blank SCRIBE_HERMES_COMMAND", () => {
    const resolved = resolveHermesCommand({
      env: { SCRIBE_HERMES_COMMAND: "   " },
      fileExists: () => false,
      candidates: [],
    });
    expect(resolved).toBeNull();
  });

  it("falls back to the first existing candidate path", () => {
    const resolved = resolveHermesCommand({
      env: {},
      fileExists: (p) => p === "/managed/venv/bin/hermes",
      candidates: ["/bundled/venv/bin/hermes", "/managed/venv/bin/hermes"],
    });
    expect(resolved).toEqual({
      command: "/managed/venv/bin/hermes",
      source: "candidate",
    });
  });

  it("returns null when nothing is found (drives the graceful skip)", () => {
    const resolved = resolveHermesCommand({
      env: {},
      fileExists: () => false,
      candidates: ["/nope/hermes"],
    });
    expect(resolved).toBeNull();
  });
});
