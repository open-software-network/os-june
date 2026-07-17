#!/usr/bin/env node
// Run with: node --experimental-strip-types scripts/hermes-smoke.ts
// (wired as `pnpm test:hermes-smoke`). Node strips the TypeScript types at load
// time so this file shares the exact helper module the Vitest unit tests cover
// (`src/lib/hermes-smoke/helpers.ts`) instead of duplicating the wire details.

/**
 * Release-gate smoke test against the pinned/bundled Hermes runtime.
 *
 * This launches Hermes the same way June does in
 * `src-tauri/src/hermes_bridge.rs` (`hermes dashboard --no-open --host
 * 127.0.0.1 --port <port>`), waits for the dashboard `/api/status` endpoint,
 * connects the JSON-RPC WebSocket at `/api/ws?token=...`, and runs a minimal
 * end-to-end gateway checklist. It is the real-runtime complement to the
 * fixture-based replay tests (feature 05) and the static compatibility matrix
 * (feature 16): those prove June handles recorded frames; this proves the
 * pinned runtime still speaks the protocol June expects.
 *
 * It is DELIBERATELY not part of `pnpm test` (vitest, jsdom). The full unit
 * suite must stay green with no live runtime and no model credentials, so this
 * is a separate opt-in command that skips gracefully (exit 0) when the Hermes
 * binary cannot be found.
 *
 * Two phases, gated independently:
 * - PROTOCOL smoke (always, when a binary exists; no provider key needed):
 *   start, status, ws connect, session.create, session.active_list,
 *   session.interrupt, and an accepted session-scoped Hermes model setting via
 *   config.set. A 4009 busy response is retried, never counted as a pass. These
 *   exercise the gateway contract without spending model tokens.
 * - MODEL smoke (opt-in via HERMES_SMOKE_MODEL=1, requires a provider key in
 *   the runtime's config): additionally runs prompt.submit with a minimal
 *   no-tool prompt and waits for a streamed completion.
 *
 * Environment:
 * - JUNE_HERMES_COMMAND   absolute path to a hermes binary (highest priority,
 *                           mirrors the Rust override). When unset, the script
 *                           probes the same bundled / managed / user-local venv
 *                           locations the bridge does.
 * - HERMES_SMOKE_MODEL=1    also run the model-costing prompt.submit phase.
 * - HERMES_SMOKE_TIMEOUT_MS per-step RPC timeout (default 120000, matches the
 *                           gateway client default).
 * - HERMES_SMOKE_READY_MS   readiness-wait budget (default 45000, matches
 *                           READY_TIMEOUT on the Rust side).
 * - HERMES_SMOKE_KEEP_HOME  keep the throwaway HERMES_HOME for inspection.
 *
 * Exit codes: 0 = all selected phases passed OR no runtime found (skip);
 * 1 = a phase failed (an artifact with logs is written next to this run).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PINNED_HERMES_VERSION } from "../src/lib/hermes-control-plane/compatibility/matrix.ts";
import {
  buildHermesDashboardArgs,
  buildRpcFrame,
  buildStatusUrl,
  buildWsUrl,
  generateSessionToken,
  parseReadinessBody,
  parseRpcFrame,
  retryModelConfigSetUntilAccepted,
  resolveHermesCommand,
  type HermesInboundFrame,
} from "../src/lib/hermes-smoke/helpers.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const HOST = "127.0.0.1";

const RPC_TIMEOUT_MS = numberEnv("HERMES_SMOKE_TIMEOUT_MS", 120_000);
const READY_TIMEOUT_MS = numberEnv("HERMES_SMOKE_READY_MS", 45_000);
const READY_POLL_MS = 500;
const RUN_MODEL_PHASE = boolEnv("HERMES_SMOKE_MODEL");
const KEEP_HOME = boolEnv("HERMES_SMOKE_KEEP_HOME");

main().catch((error) => {
  console.error(`hermes-smoke: unexpected failure: ${describeError(error)}`);
  process.exit(1);
});

async function main(): Promise<void> {
  console.log(`hermes-smoke: release gate for pinned Hermes ${PINNED_HERMES_VERSION}`);

  const resolved = resolveHermesCommand({
    env: process.env,
    fileExists: existsSync,
    candidates: hermesCandidatePaths(),
  });

  if (!resolved) {
    const override = process.env.JUNE_HERMES_COMMAND?.trim();
    if (override) {
      console.log(
        `hermes-smoke: JUNE_HERMES_COMMAND points at a missing file (${override}); ` +
          "Hermes runtime not found, skipping.",
      );
    } else {
      console.log(
        "hermes-smoke: Hermes runtime not found, skipping. Set JUNE_HERMES_COMMAND " +
          "to a hermes binary, or install the bundled/managed runtime, to run the smoke test.",
      );
    }
    process.exit(0);
  }

  console.log(`hermes-smoke: using hermes (${resolved.source}): ${resolved.command}`);

  const port = await allocatePort();
  const token = generateSessionToken();
  const home = mkdtempSync(join(tmpdir(), "june-hermes-smoke-"));
  const smokeProvider = await startSmokeProvider();
  writeMinimalConfig(home, smokeProvider.port);

  const log: string[] = [];
  const record = (line: string) => {
    log.push(line);
    console.log(line);
  };

  const child = spawn(resolved.command, buildHermesDashboardArgs(HOST, port), {
    cwd: home,
    env: {
      ...process.env,
      HERMES_HOME: home,
      JUNE_HERMES_HOME: home,
      HERMES_DASHBOARD_SESSION_TOKEN: token,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childExited = false;
  let childExitInfo = "";
  child.stdout?.on("data", (chunk) => log.push(`[hermes stdout] ${chunk}`));
  child.stderr?.on("data", (chunk) => log.push(`[hermes stderr] ${chunk}`));
  child.on("exit", (code, signal) => {
    childExited = true;
    childExitInfo = `code=${code ?? "null"} signal=${signal ?? "null"}`;
  });

  let socket: WebSocket | undefined;
  let failed = false;

  try {
    record(`hermes-smoke: spawned hermes dashboard on ${HOST}:${port} (pid ${child.pid ?? "?"})`);

    await waitForStatus(
      port,
      token,
      () => childExited,
      () => childExitInfo,
    );
    record("hermes-smoke: PASS dashboard /api/status responded");

    await assertDefaultCronJobsEndpoint(port, token, record);

    socket = await connectGateway(port, token);
    record("hermes-smoke: PASS /api/ws connected with the token auth flow");

    const rpc = makeRpcClient(socket);

    // session.create — June's AgentWorkspace creates every session this way.
    const created = await rpc.request("session.create", {
      title: "Release-gate smoke",
      cols: 96,
    });
    const runtimeSessionId = runtimeSessionIdFrom(created);
    if (!runtimeSessionId) {
      throw new Error(`session.create returned no runtime session id: ${safeJson(created)}`);
    }
    record(`hermes-smoke: PASS session.create -> ${runtimeSessionId}`);

    // session.active_list — June polls this as ground truth for what runs.
    const active = await rpc.request("session.active_list", {});
    if (!active || typeof active !== "object" || !("sessions" in active)) {
      throw new Error(`session.active_list missing sessions array: ${safeJson(active)}`);
    }
    record("hermes-smoke: PASS session.active_list returned a sessions list");

    // Session-scoped Hermes model setting via config.set. Busy is retryable,
    // but the release gate passes only after the mutation is accepted.
    await setSessionModel(rpc, runtimeSessionId, record);

    // MODEL phase: only when explicitly opted in (spends provider tokens).
    if (RUN_MODEL_PHASE) {
      await runModelPhase(rpc, runtimeSessionId, record);
    } else {
      record(
        "hermes-smoke: SKIP model phase (prompt.submit). Set HERMES_SMOKE_MODEL=1 " +
          "with a provider key in the runtime config to run it.",
      );
    }

    // session.interrupt — halting a turn must be accepted by the gateway. After
    // the model phase a turn may be settling; in protocol-only mode the session
    // is idle, and interrupting an idle session is still a valid, accepted call.
    await rpc.request("session.interrupt", { session_id: runtimeSessionId });
    record("hermes-smoke: PASS session.interrupt accepted");

    record("hermes-smoke: all selected phases passed");
  } catch (error) {
    failed = true;
    record(`hermes-smoke: FAIL ${describeError(error)}`);
  } finally {
    try {
      socket?.close();
    } catch {
      // best effort
    }
    await stopChild(child, childExited);
    if (failed) {
      const artifact = writeArtifact(log);
      console.error(`hermes-smoke: wrote failure log to ${artifact}`);
    }
    if (KEEP_HOME) {
      console.log(`hermes-smoke: kept HERMES_HOME at ${home}`);
    } else {
      rmSync(home, { recursive: true, force: true });
    }
    await smokeProvider.close();
  }

  process.exit(failed ? 1 : 0);
}

/**
 * The ordered binary locations the bridge probes, minus the env override (the
 * helper applies that). The production bridge accepts only June-bundled or
 * June-managed patched runtimes; this standalone developer smoke also probes
 * common local install paths so it can be run before packaging.
 */
function hermesCandidatePaths(): string[] {
  const windows = process.platform === "win32";
  const venvBin = (root: string) =>
    windows ? join(root, "Scripts", "hermes.exe") : join(root, "bin", "hermes");
  const candidates: string[] = [];
  // Managed runtime under the worktree-local app data is not knowable here, so
  // probe common developer-local install locations for this standalone smoke.
  const home = homedir();
  if (home) {
    candidates.push(venvBin(join(home, ".hermes", "hermes-agent", "venv")));
    candidates.push(
      windows ? join(home, ".local", "bin", "hermes.exe") : join(home, ".local", "bin", "hermes"),
    );
  }
  return candidates;
}

/** Binds an ephemeral port the same way `pick_port()` does (bind :0, read the
 * assigned port, release it), then hands it to the spawn. */
function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolvePort(port));
      } else {
        server.close(() => reject(new Error("could not allocate a port")));
      }
    });
  });
}

/** Writes the minimum config.yaml Hermes needs to boot its dashboard. The
 * protocol phase validates the model against the local listing stub but never
 * calls it for inference. The model phase still expects the operator to supply
 * real provider config through the runtime environment. */
function writeMinimalConfig(home: string, providerPort: number): void {
  const config = [
    "model:",
    "  default: smoke-model",
    "  provider: custom",
    `  base_url: http://${HOST}:${providerPort}/v1`,
    "  api_key: smoke-no-credential",
    "  api_mode: chat_completions",
    "agent:",
    "  max_turns: 4",
    "display:",
    "  skin: mono",
    "",
  ].join("\n");
  writeFileSync(join(home, "config.yaml"), config, "utf8");
}

/** Starts a token-free local `/v1/models` endpoint for the protocol phase.
 * `config.set` validates custom-provider model ids even though it does not run
 * inference, so using port 9 would turn this protocol gate into a guaranteed
 * endpoint failure. The stub lists only the configured smoke model and never
 * implements chat completions. */
function startSmokeProvider(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolveProvider, reject) => {
    const server = createHttpServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "smoke-model", object: "model" },
              { id: "smoke-model-alt", object: "model" },
            ],
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate the smoke provider port"));
        return;
      }
      resolveProvider({
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

/** Polls GET /api/status with the Bearer token until it succeeds, the deadline
 * passes, or the child dies (mirrors wait_for_hermes, including no-proxy via
 * the NO_PROXY env we set on the child and the localhost target). */
async function waitForStatus(
  port: number,
  token: string,
  hasExited: () => boolean,
  exitInfo: () => string,
): Promise<void> {
  const url = buildStatusUrl(HOST, port);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "timeout";
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error(`hermes exited before becoming ready (${exitInfo()})`);
    }
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const parsed = parseReadinessBody(await response.text());
        // Ready when /api/status returns valid JSON — this mirrors the Rust
        // `wait_for_hermes`, which returns on a 2xx alone. The embedded chat
        // gateway (/api/ws) the smoke test connects to is always enabled once
        // the dashboard is up (see hermes_bridge.rs). We deliberately do NOT
        // gate on `gateway_running`: that flag tracks the SEPARATE launchd
        // messaging gateway (routines/Slack), which the smoke test never starts
        // — gating on it would time out against a perfectly healthy runtime.
        if (parsed.ok) return;
        lastError = "status body was not JSON yet";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = describeError(error);
    }
    await delay(READY_POLL_MS);
  }
  throw new Error(`hermes did not become ready: ${lastError}`);
}

/** Routines reads the default profile's cron jobs. This endpoint previously
 * regressed to HTTP 500 when bundled plugins shadowed Hermes core `cron`. */
async function assertDefaultCronJobsEndpoint(
  port: number,
  token: string,
  record: (line: string) => void,
): Promise<void> {
  const url = `http://${HOST}:${port}/api/cron/jobs?profile=default`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "X-Hermes-Session-Token": token,
    },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `/api/cron/jobs?profile=default returned HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`/api/cron/jobs?profile=default returned invalid JSON: ${body.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `/api/cron/jobs?profile=default returned a non-array body: ${safeJson(parsed)}`,
    );
  }
  record(`hermes-smoke: PASS /api/cron/jobs?profile=default returned ${parsed.length} job(s)`);
}

/** Opens the JSON-RPC WebSocket at /api/ws?token=... and resolves once the
 * socket is open. Uses the global WebSocket (Node 22+). */
function connectGateway(port: number, token: string): Promise<WebSocket> {
  const url = buildWsUrl(HOST, port, token);
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      reject(new Error("ws connection timed out"));
      try {
        socket.close();
      } catch {
        // ignore
      }
    }, 15_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolveSocket(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("could not connect to /api/ws"));
      },
      { once: true },
    );
  });
}

type RpcClient = {
  request: (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  onEvent: (handler: (type: string, params: Record<string, unknown>) => void) => void;
};

/** A minimal JSON-RPC client over the open socket, framing requests with
 * buildRpcFrame and routing replies/events with parseRpcFrame — the same shapes
 * HermesGatewayClient uses, so a protocol drift surfaces here. */
function makeRpcClient(socket: WebSocket): RpcClient {
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const eventHandlers: Array<(type: string, params: Record<string, unknown>) => void> = [];

  socket.addEventListener("message", (event) => {
    const frame: HermesInboundFrame = parseRpcFrame(String(event.data));
    if (frame.kind === "result") {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(frame.id);
      waiter.resolve(frame.result);
    } else if (frame.kind === "error") {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(frame.id);
      const rpcError = new Error(frame.message) as Error & { code?: number };
      rpcError.code = frame.code;
      waiter.reject(rpcError);
    } else if (frame.kind === "event") {
      for (const handler of eventHandlers) handler(frame.type, frame.params);
    }
  });

  socket.addEventListener("close", () => {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("gateway connection closed"));
    }
    pending.clear();
  });

  return {
    request(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
      nextId += 1;
      const id = nextId;
      return new Promise<unknown>((resolveValue, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`request timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve: resolveValue, reject, timer });
        socket.send(JSON.stringify(buildRpcFrame(id, method, params)));
      });
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
  };
}

/** Session-scoped Hermes model setting: the release gate must confirm the
 * runtime accepts the exact mutation June uses. The documented 4009 busy guard
 * is retried within the RPC budget; it never counts as acceptance. */
async function setSessionModel(
  rpc: RpcClient,
  runtimeSessionId: string,
  record: (line: string) => void,
): Promise<void> {
  try {
    await retryModelConfigSetUntilAccepted(
      () =>
        rpc.request("config.set", {
          session_id: runtimeSessionId,
          key: "model",
          value: "smoke-model-alt --session",
          confirm_expensive_model: true,
        }),
      { timeoutMs: RPC_TIMEOUT_MS, wait: delay },
    );
    record("hermes-smoke: PASS session-scoped Hermes model setting accepted");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(
      `session-scoped Hermes model setting was not accepted ` +
        `(code=${code ?? "none"}): ${describeError(error)}`,
    );
  }
}

/** The model-costing phase: submit a tiny no-tool prompt and wait for the
 * stream to complete. Skipped unless HERMES_SMOKE_MODEL=1. */
async function runModelPhase(
  rpc: RpcClient,
  runtimeSessionId: string,
  record: (line: string) => void,
): Promise<void> {
  record("hermes-smoke: running model phase (prompt.submit, spends tokens)");
  const completed = new Promise<void>((resolveDone, reject) => {
    const timer = setTimeout(
      () => reject(new Error("prompt.submit did not complete in time")),
      RPC_TIMEOUT_MS,
    );
    rpc.onEvent((type) => {
      if (type === "message.complete") {
        clearTimeout(timer);
        resolveDone();
      } else if (type === "error") {
        clearTimeout(timer);
        reject(new Error("gateway emitted an error event during prompt.submit"));
      }
    });
  });
  await rpc.request("prompt.submit", {
    session_id: runtimeSessionId,
    text: "Reply with the single word: ok",
  });
  await completed;
  record("hermes-smoke: PASS prompt.submit produced a completion");
}

/** Stops the hermes child cleanly: SIGTERM, then SIGKILL if it lingers. */
async function stopChild(child: ReturnType<typeof spawn>, alreadyExited: boolean): Promise<void> {
  if (alreadyExited || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise<boolean>((r) => child.once("exit", () => r(true))),
    delay(5_000).then(() => false),
  ]);
  if (!stopped) child.kill("SIGKILL");
}

function writeArtifact(log: string[]): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(REPO_ROOT, `hermes-smoke-failure-${stamp}.log`);
  writeFileSync(path, `${log.join("\n")}\n`, "utf8");
  return path;
}

function runtimeSessionIdFrom(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const runtimeSessionId = record.session_id;
  return typeof runtimeSessionId === "string" && runtimeSessionId.length > 0
    ? runtimeSessionId
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
