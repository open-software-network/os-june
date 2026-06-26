/**
 * Pure, dependency-free helpers for the release-gate Hermes smoke test
 * (`scripts/hermes-smoke.ts`). They are extracted from the launch/connect path
 * so the wire details June relies on can be unit-tested in `src/test/` without a
 * live runtime, keeping `pnpm test` green and the smoke script thin.
 *
 * Every helper here mirrors a concrete piece of `src-tauri/src/hermes_bridge.rs`
 * (or the gateway client in `../hermes-gateway.ts`): the dashboard command line,
 * the session token shape, the ws-url + readiness-probe URLs, the JSON-RPC
 * request/response framing, and the binary discovery order. If the Rust side
 * changes, these and their tests change with it: that is the point of the
 * matrix-style pinning.
 *
 * The module is intentionally runtime-agnostic (no node:net, no fetch, no
 * WebSocket): the script supplies those. That keeps this file importable from
 * jsdom Vitest and trivially testable.
 */

/** Length of the dashboard session token. Rust: `take(43)` over `Alphanumeric`
 * in `random_token()`. */
export const HERMES_TOKEN_LENGTH = 43;

const TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A 43-character alphanumeric token, matching `random_token()`. June sets it on
 * `HERMES_DASHBOARD_SESSION_TOKEN` and carries it in the ws-url query and the
 * `Authorization: Bearer` readiness header, so the smoke test must mint one the
 * same shape. Uses `crypto.getRandomValues` when present (browsers / Node 19+)
 * and falls back to `Math.random` only so the helper never throws in a bare
 * test environment; the smoke script always runs under Node, which has crypto.
 */
export function generateSessionToken(length = HERMES_TOKEN_LENGTH): string {
  const out = new Array<string>(length);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(length);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < length; i += 1) {
      out[i] = TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
    }
  } else {
    for (let i = 0; i < length; i += 1) {
      out[i] =
        TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
    }
  }
  return out.join("");
}

/**
 * The JSON-RPC WebSocket URL June connects to. Mirrors the `ws_url` built in
 * `start_hermes_bridge_inner`: `ws://{host}:{port}/api/ws?token={encoded}`,
 * where the token is percent-encoded (Rust `urlencoding::encode`).
 */
export function buildWsUrl(host: string, port: number, token: string): string {
  return `ws://${host}:${port}/api/ws?token=${encodeURIComponent(token)}`;
}

/** The dashboard status endpoint the readiness probe polls. Mirrors
 * `wait_for_hermes`, which GETs `{base_url}/api/status`. */
export function buildStatusUrl(host: string, port: number): string {
  return `http://${host}:${port}/api/status`;
}

/**
 * The argument vector for the dashboard subprocess. Mirrors the `hermes_args`
 * array in `start_hermes_bridge_inner` exactly: no `--tui` (upstream removed it
 * before v2026.6.19; passing it is an argparse error).
 */
export function buildHermesDashboardArgs(
  host: string,
  port: number,
): [string, string, string, string, string, string] {
  return ["dashboard", "--no-open", "--host", host, "--port", String(port)];
}

/** A JSON-RPC 2.0 request frame, identical to what `HermesGatewayClient.request`
 * sends: `{jsonrpc:"2.0", id, method, params}`. */
export type HermesRpcRequestFrame = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
};

export function buildRpcFrame(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): HermesRpcRequestFrame {
  return { jsonrpc: "2.0", id, method, params };
}

/** The outcome of reading `/api/status`. `ok` is false when the body isn't JSON
 * (a proxy error page, a partial write during startup, etc.). */
export type HermesReadiness = { ok: boolean; gatewayRunning: boolean };

/**
 * Parses an `/api/status` response body the way the bridge reads it: a JSON
 * object whose optional boolean `gateway_running` flag tells whether the
 * messaging gateway is up (`start_hermes_gateway_if_needed`). Never throws — a
 * non-JSON body just reports `{ ok: false }` so the probe can keep polling.
 */
export function parseReadinessBody(body: string): HermesReadiness {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, gatewayRunning: false };
    }
    const flag = (parsed as { gateway_running?: unknown }).gateway_running;
    return { ok: true, gatewayRunning: flag === true };
  } catch {
    return { ok: false, gatewayRunning: false };
  }
}

/**
 * A parsed inbound gateway frame. Mirrors the branches in
 * `HermesGatewayClient.handleMessage`:
 * - a frame with an `id` is an RPC reply: `result` (success) or `error` (carrying
 *   the JSON-RPC `code`, e.g. 4009 "session busy");
 * - a `{method:"event", params:{type}}` frame is an event notification;
 * - anything unparseable or unrecognized is ignored (the client drops it).
 */
export type HermesInboundFrame =
  | { kind: "result"; id: number; result: unknown }
  | { kind: "error"; id: number; code?: number; message: string }
  | { kind: "event"; type: string; params: Record<string, unknown> }
  | { kind: "ignore" };

export function parseRpcFrame(raw: string): HermesInboundFrame {
  let frame: {
    id?: number | string | null;
    method?: string;
    params?: { type?: string } & Record<string, unknown>;
    result?: unknown;
    error?: { code?: number; message?: string };
  };
  try {
    frame = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  if (frame.id !== undefined && frame.id !== null) {
    const id = Number(frame.id);
    if (frame.error) {
      return {
        kind: "error",
        id,
        code: frame.error.code,
        message: frame.error.message ?? "Hermes RPC failed.",
      };
    }
    return { kind: "result", id, result: frame.result };
  }
  if (frame.method === "event" && frame.params?.type) {
    return { kind: "event", type: frame.params.type, params: frame.params };
  }
  return { kind: "ignore" };
}

/**
 * The lowest JSON-RPC code that is still an APPLICATION-level Hermes error
 * (rather than a transport/protocol error). JSON-RPC reserves the band from
 * -32768 to -32000 for protocol errors (e.g. -32601 method-not-found); Hermes
 * raises its own controlled responses with positive codes in the 4xxx range
 * (e.g. 4009 "session busy", 4018 "not a quick/plugin/skill command"). The
 * smoke gate treats only these positive application codes as an acceptable
 * outcome for a bare `/model` dispatch.
 */
export const HERMES_APP_ERROR_CODE_FLOOR = 4000;

/**
 * Whether a rejection from `command.dispatch /model` is a CONTROLLED,
 * application-level Hermes error — the only rejection the smoke gate may treat
 * as a PASS. A bare `/model` legitimately comes back as a controlled refusal
 * (e.g. 4018 "not a quick/plugin/skill command", or 4009 "session busy"), which
 * proves the gateway is alive and speaking the protocol.
 *
 * Returns false for everything that signals a real regression — a missing or
 * non-numeric `code`, or a JSON-RPC protocol error (the reserved band at or
 * below -32000, e.g. -32601 method-not-found) — so a changed error shape, an
 * auth/session failure, or a vanished method FAILS the gate instead of passing.
 */
export function isControlledModelDispatchError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "number" || !Number.isFinite(code)) return false;
  return code >= HERMES_APP_ERROR_CODE_FLOOR;
}

/** Where a resolved Hermes command came from, for log clarity. `env_override`
 * mirrors `SCRIBE_HERMES_COMMAND`; `candidate` covers the bundled / managed /
 * user-local venv paths the Rust side probes in order. */
export type HermesCommandSource = "env_override" | "candidate";

export type ResolvedHermesCommand = {
  command: string;
  source: HermesCommandSource;
};

export type ResolveHermesCommandOptions = {
  /** Process environment (defaults supplied by the caller / script). */
  env: Record<string, string | undefined>;
  /** Predicate for "this path is an existing file". The script passes a real
   * `existsSync`; tests pass a stub. */
  fileExists: (path: string) => boolean;
  /** Ordered fallback paths to probe when no env override is set. The script
   * builds these to mirror `resolve_hermes_command` (bundled venv, managed
   * venv, `~/.hermes` venv, `~/.local/bin/hermes`). */
  candidates?: string[];
};

/**
 * Resolves the Hermes binary the smoke test should launch, mirroring the
 * discovery order in `resolve_hermes_command`:
 * 1. `SCRIBE_HERMES_COMMAND` if set, non-blank, and pointing at an existing file;
 * 2. otherwise the first existing path in `candidates`.
 *
 * Returns `null` when nothing is found, which is exactly the signal the script
 * uses to skip gracefully (print "Hermes runtime not found" and exit 0) rather
 * than fail a developer machine that has no runtime installed.
 */
export function resolveHermesCommand(
  options: ResolveHermesCommandOptions,
): ResolvedHermesCommand | null {
  const override = options.env.SCRIBE_HERMES_COMMAND?.trim();
  if (override) {
    return options.fileExists(override)
      ? { command: override, source: "env_override" }
      : null;
  }
  for (const candidate of options.candidates ?? []) {
    if (options.fileExists(candidate)) {
      return { command: candidate, source: "candidate" };
    }
  }
  return null;
}
