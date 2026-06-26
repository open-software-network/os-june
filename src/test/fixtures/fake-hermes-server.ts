/**
 * Fake Hermes dashboard server (spec 24). Test infrastructure — NOT a test.
 * vitest only collects `*.{test,spec}.*`, so this `.ts` is never run as a suite;
 * it is imported by the admin client/cache/lifecycle tests so they exercise the
 * real REST surface without launching the pinned Hermes runtime.
 *
 * It is a stateful, `fetch`-shaped fake: construct one with a scenario fixture,
 * pass `server.fetch` as the admin client's `fetch`, and the client makes
 * genuine requests (auth header, profile query, JSON parse, error normalization)
 * against in-memory state. Mutations mutate that state, so a toggle-then-list
 * round-trips; backgrounded actions advance over polls so action-status polling
 * is exercised end to end.
 *
 * What it simulates (the documented dashboard admin surface June uses):
 *   GET    /api/skills
 *   PUT    /api/skills/toggle
 *   GET    /api/skills/hub/search
 *   POST   /api/skills/hub/install | /uninstall | /update
 *   GET    /api/tools/toolsets
 *   PUT    /api/tools/toolsets/{name}
 *   GET    /api/mcp/servers
 *   POST   /api/mcp/servers
 *   POST   /api/mcp/servers/{name}/test
 *   PUT    /api/mcp/servers/{name}/enabled
 *   DELETE /api/mcp/servers/{name}
 *   GET    /api/mcp/catalog
 *   POST   /api/mcp/catalog/install
 *   GET    /api/status
 *   POST   /api/gateway/restart | /start | /stop
 *   GET    /api/actions/{name}/status
 *   GET    /api/env
 *   PUT    /api/env
 *   DELETE /api/env
 *   POST   /api/env/reveal
 *
 * SECURITY: fixtures here use OBVIOUSLY FAKE secrets (e.g. `sk-FAKE-...`) so a
 * redaction-leak test that asserts a fake token never appears in a log line has
 * a real (fake) value to look for. Never put a real credential in a fixture.
 *
 * FIXTURE UPDATE GUIDE (on a Hermes pin bump): see
 * `src/test/fixtures/README.md`.
 */

// ---------------------------------------------------------------------------
// Fixture model
// ---------------------------------------------------------------------------

export type FakeSkill = {
  name: string;
  description?: string;
  enabled: boolean;
  source?: "bundled" | "hub" | "external";
  read_only?: boolean;
  version?: string;
};

export type FakeToolset = {
  name: string;
  description?: string;
  enabled: boolean;
  tools?: string[];
  requirements?: Array<{ label: string; satisfied?: boolean }>;
};

export type FakeMcpServer = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "http-oauth";
  command?: string;
  url?: string;
  auth_status?:
    | "authenticated"
    | "unauthenticated"
    | "expired"
    | "not-required";
  status?: "connected" | "error" | "untested";
  status_message?: string;
  tools?: Array<{ name: string; description?: string; enabled?: boolean }>;
  include_tools?: string[];
  exclude_tools?: string[];
  /** When set, `POST /test` reports this outcome instead of "connected". */
  testOutcome?: { ok: boolean; message?: string; delayMs?: number };
  /** Secret-bearing config the server stores but must NEVER echo back in GETs
   * (the client never reads it; present to prove redaction on the request side
   * and that responses do not leak it). */
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export type FakeCatalogEntry = {
  /** The install identifier — the real `MCPCatalogInstall` requires `name`. */
  name: string;
  /** Optional separate slug/id; real catalog entries are keyed by `name`. */
  id?: string;
  description?: string;
  transport: "stdio" | "http" | "http-oauth";
  installed?: boolean;
  requires_oauth?: boolean;
};

export type FakeHubResult = {
  identifier: string;
  name?: string;
  description?: string;
  source?: string;
  installed?: boolean;
};

/** A backgrounded action's scripted progression: one status per poll, the last
 * repeated once exhausted. Lets a test drive queued → running → succeeded. */
export type FakeActionScript = {
  /** Sequence of states returned on successive polls. */
  states: Array<{
    state: "queued" | "running" | "succeeded" | "failed";
    progress?: number;
    message?: string;
    error?: string;
  }>;
};

export type FakeHermesScenario = {
  /** The auth token the server requires on `X-Hermes-Session-Token`. */
  token?: string;
  skills?: FakeSkill[];
  toolsets?: FakeToolset[];
  mcpServers?: FakeMcpServer[];
  mcpCatalog?: FakeCatalogEntry[];
  hubResults?: FakeHubResult[];
  gateway?: { gateway_running?: boolean; version?: string };
  /** Initial env keys (values never returned). */
  env?: Record<string, string>;
  /** When true, hub installs / catalog installs / gateway restart return an
   * action handle and require polling. When false, they complete synchronously. */
  backgroundActions?: boolean;
  /** Per-action scripts, keyed by action name, overriding the default
   * "running once then succeeded" progression. */
  actionScripts?: Record<string, FakeActionScript>;
};

export type FakeRequestLogEntry = {
  method: string;
  path: string;
  /** Query params as a plain object. */
  query: Record<string, string>;
  /** The token the request presented (so a test can assert it was sent). */
  token?: string;
  /** Parsed JSON body, when present. */
  body?: unknown;
};

const PINNED_HERMES_VERSION = "v2026.6.19";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type ActionRecord = {
  name: string;
  script: FakeActionScript;
  /** How many times the action has been polled. */
  polls: number;
};

export class FakeHermesServer {
  readonly baseUrl = "http://127.0.0.1:65535";
  readonly token: string;

  private skills: FakeSkill[];
  private toolsets: FakeToolset[];
  private mcpServers: FakeMcpServer[];
  private mcpCatalog: FakeCatalogEntry[];
  private hubResults: FakeHubResult[];
  private gateway: { gateway_running: boolean; version: string };
  private env: Record<string, string>;
  private readonly backgroundActions: boolean;
  private readonly actionScripts: Record<string, FakeActionScript>;
  private readonly actions = new Map<string, ActionRecord>();
  private actionSeq = 0;

  /** Every request the client made, in order. Tests assert on auth, profile
   * query, and bodies via this log. */
  readonly requestLog: FakeRequestLogEntry[] = [];

  constructor(scenario: FakeHermesScenario = {}) {
    this.token = scenario.token ?? "fake-dashboard-token";
    this.skills = clone(scenario.skills ?? []);
    this.toolsets = clone(scenario.toolsets ?? []);
    this.mcpServers = clone(scenario.mcpServers ?? []);
    this.mcpCatalog = clone(scenario.mcpCatalog ?? []);
    this.hubResults = clone(scenario.hubResults ?? []);
    this.gateway = {
      gateway_running: scenario.gateway?.gateway_running ?? false,
      version: scenario.gateway?.version ?? PINNED_HERMES_VERSION,
    };
    this.env = clone(scenario.env ?? {});
    this.backgroundActions = scenario.backgroundActions ?? false;
    this.actionScripts = scenario.actionScripts ?? {};
  }

  /** A `fetch`-compatible bound method to hand to the admin client. */
  readonly fetch = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const token = headerValue(init?.headers, "X-Hermes-Session-Token");
    const body = parseBody(init?.body);
    this.requestLog.push({ method, path, query, token, body });

    // Auth gate: a missing/wrong token is 401, exactly like the real dashboard.
    if (token !== this.token) {
      return json(401, { code: "unauthorized", error: "invalid token" });
    }

    try {
      return this.route(method, path, query, body);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.status, error.payload);
      }
      return json(500, { code: "internal", error: "fake server error" });
    }
  };

  // --- routing -------------------------------------------------------------

  private route(
    method: string,
    path: string,
    query: Record<string, string>,
    body: unknown,
  ): Response {
    // Skills
    if (method === "GET" && path === "/api/skills") {
      return json(200, { skills: this.skills });
    }
    if (method === "PUT" && path === "/api/skills/toggle") {
      const { name, enabled } = requireToggleBody(body);
      const skill = this.skills.find((s) => s.name === name);
      if (!skill) throw new HttpError(404, { code: "not_found" });
      skill.enabled = enabled;
      return json(200, { ok: true, name, enabled });
    }
    if (method === "GET" && path === "/api/skills/hub/search") {
      const q = (query.q ?? "").toLowerCase();
      const results = q
        ? this.hubResults.filter(
            (r) =>
              r.identifier.toLowerCase().includes(q) ||
              (r.name ?? "").toLowerCase().includes(q),
          )
        : this.hubResults;
      return json(200, { results });
    }
    if (method === "POST" && path === "/api/skills/hub/install") {
      return this.startOrComplete("install");
    }
    if (method === "POST" && path === "/api/skills/hub/uninstall") {
      return this.startOrComplete("uninstall");
    }
    if (method === "POST" && path === "/api/skills/hub/update") {
      return this.startOrComplete("update");
    }

    // Toolsets
    if (method === "GET" && path === "/api/tools/toolsets") {
      return json(200, { toolsets: this.toolsets });
    }
    if (method === "PUT" && path.startsWith("/api/tools/toolsets/")) {
      const name = decodeURIComponent(
        path.slice("/api/tools/toolsets/".length),
      );
      const toolset = this.toolsets.find((t) => t.name === name);
      if (!toolset) throw new HttpError(404, { code: "not_found" });
      toolset.enabled = Boolean((body as { enabled?: boolean })?.enabled);
      return json(200, { ok: true, name, enabled: toolset.enabled });
    }

    // MCP servers
    if (method === "GET" && path === "/api/mcp/servers") {
      return json(200, { servers: this.mcpServers.map(stripMcpSecrets) });
    }
    if (method === "POST" && path === "/api/mcp/servers") {
      return this.addMcpServer(body);
    }
    const testMatch = matchPath(path, "/api/mcp/servers/:name/test");
    if (method === "POST" && testMatch) {
      return this.testMcpServer(testMatch.name);
    }
    const enabledMatch = matchPath(path, "/api/mcp/servers/:name/enabled");
    if (method === "PUT" && enabledMatch) {
      const server = this.requireServer(enabledMatch.name);
      server.enabled = Boolean((body as { enabled?: boolean })?.enabled);
      return json(200, {
        ok: true,
        name: server.name,
        enabled: server.enabled,
      });
    }
    // NOTE: no `/api/mcp/servers/:name/tools` route — the real v2026.6.19
    // dashboard does not expose one, and MCPServerCreate has no filter field.
    const removeMatch = matchPath(path, "/api/mcp/servers/:name");
    if (method === "DELETE" && removeMatch) {
      const before = this.mcpServers.length;
      this.mcpServers = this.mcpServers.filter(
        (s) => s.name !== removeMatch.name,
      );
      if (this.mcpServers.length === before) {
        throw new HttpError(404, { code: "not_found" });
      }
      return json(200, { ok: true });
    }

    // MCP catalog
    if (method === "GET" && path === "/api/mcp/catalog") {
      return json(200, { catalog: this.mcpCatalog });
    }
    if (method === "POST" && path === "/api/mcp/catalog/install") {
      // MCPCatalogInstall requires `name` (NOT `id`) — reject a missing name
      // with 422 so a client sending the wrong field fails loudly, as real
      // Hermes would.
      const installName = (body as { name?: unknown })?.name;
      if (typeof installName !== "string" || installName.length === 0) {
        throw new HttpError(422, {
          code: "validation_error",
          error: "field required: name",
        });
      }
      return this.startOrComplete("catalog-install");
    }

    // Gateway lifecycle
    if (method === "GET" && path === "/api/status") {
      return json(200, {
        gateway_running: this.gateway.gateway_running,
        version: this.gateway.version,
      });
    }
    if (method === "POST" && path === "/api/gateway/restart") {
      this.gateway.gateway_running = true;
      return this.startOrComplete("gateway-restart");
    }
    if (method === "POST" && path === "/api/gateway/start") {
      this.gateway.gateway_running = true;
      return this.startOrComplete("gateway-start");
    }
    if (method === "POST" && path === "/api/gateway/stop") {
      this.gateway.gateway_running = false;
      return this.startOrComplete("gateway-stop");
    }

    // Actions
    const actionMatch = matchPath(path, "/api/actions/:name/status");
    if (method === "GET" && actionMatch) {
      return this.actionStatus(actionMatch.name);
    }

    // Env. Matches the real contract: PUT to set, DELETE with the key in the
    // BODY (not the path), GET to list (values masked, never returned), and
    // POST /reveal to read one plaintext value on demand.
    if (method === "GET" && path === "/api/env") {
      // The listing reports presence + a masked preview, never the value.
      const vars = Object.entries(this.env).map(([key, value]) => ({
        key,
        has_value: value.length > 0,
        preview: maskValue(value),
      }));
      return json(200, { vars });
    }
    if (method === "PUT" && path === "/api/env") {
      const { key, value } = (body as { key?: string; value?: string }) ?? {};
      if (typeof key !== "string" || typeof value !== "string") {
        throw new HttpError(422, {
          code: "validation_error",
          error: "field required: key, value",
        });
      }
      this.env[key] = value;
      return json(200, { ok: true, key, applies_at: "gateway-restart" });
    }
    if (method === "DELETE" && path === "/api/env") {
      const key = (body as { key?: unknown })?.key;
      if (typeof key !== "string" || key.length === 0) {
        throw new HttpError(422, {
          code: "validation_error",
          error: "field required: key",
        });
      }
      delete this.env[key];
      return json(200, { ok: true, key, applies_at: "gateway-restart" });
    }
    if (method === "POST" && path === "/api/env/reveal") {
      const key = (body as { key?: unknown })?.key;
      if (typeof key !== "string" || key.length === 0) {
        throw new HttpError(422, {
          code: "validation_error",
          error: "field required: key",
        });
      }
      // Reveal DOES return the plaintext value (that is its purpose).
      return json(200, { key, value: this.env[key] ?? "" });
    }

    throw new HttpError(404, { code: "not_found", error: `no route ${path}` });
  }

  // --- MCP helpers ---------------------------------------------------------

  private addMcpServer(body: unknown): Response {
    const payload = (body as Partial<FakeMcpServer>) ?? {};
    if (!payload.name) throw new HttpError(400, { code: "bad_request" });
    if (this.mcpServers.some((s) => s.name === payload.name)) {
      throw new HttpError(409, { code: "conflict", error: "already exists" });
    }
    const server: FakeMcpServer = {
      name: payload.name,
      enabled: payload.enabled ?? true,
      transport: payload.transport ?? (payload.command ? "stdio" : "http"),
      command: payload.command,
      url: payload.url,
      auth_status: payload.auth_status,
      status: "untested",
      env: payload.env,
      headers: payload.headers,
    };
    this.mcpServers.push(server);
    return json(200, stripMcpSecrets(server));
  }

  private testMcpServer(name: string): Response {
    const server = this.requireServer(name);
    const outcome = server.testOutcome ?? { ok: true };
    server.status = outcome.ok ? "connected" : "error";
    server.status_message = outcome.message;
    return json(200, {
      ok: outcome.ok,
      message: outcome.message,
      tools: server.tools ?? [],
    });
  }

  private requireServer(name: string): FakeMcpServer {
    const server = this.mcpServers.find((s) => s.name === name);
    if (!server) throw new HttpError(404, { code: "not_found" });
    return server;
  }

  // --- action lifecycle ----------------------------------------------------

  /** Either starts a backgrounded action (returns an action handle) or completes
   * synchronously, per the scenario's `backgroundActions`. */
  private startOrComplete(kind: string): Response {
    if (!this.backgroundActions) {
      return json(200, { ok: true });
    }
    const name = `${kind}-${++this.actionSeq}`;
    const script: FakeActionScript = this.actionScripts[kind] ??
      this.actionScripts[name] ?? {
        states: [
          { state: "running", progress: 50 },
          { state: "succeeded", progress: 100 },
        ],
      };
    this.actions.set(name, { name, script, polls: 0 });
    return json(202, { action: name, state: "queued" });
  }

  private actionStatus(name: string): Response {
    const record = this.actions.get(name);
    if (!record) throw new HttpError(404, { code: "not_found" });
    const { states } = record.script;
    const index = Math.min(record.polls, states.length - 1);
    record.polls += 1;
    const step = states[index];
    return json(200, {
      action: name,
      state: step.state,
      progress: step.progress,
      message: step.message,
      error: step.error,
      done: step.state === "succeeded" || step.state === "failed",
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(`HTTP ${status}`);
  }
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A masked, non-secret preview of an env value for the GET /api/env listing
 * (e.g. `sk-1...wxyz`). Mirrors the real dashboard, which never returns the full
 * value in the listing — only on reveal. */
function maskValue(value: string): string {
  if (value.length === 0) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}

/** Removes secret-bearing config from an MCP server before it is serialized into
 * a GET response — the real dashboard does not echo env/headers back, and our
 * fake must not either, so a "no secret in a response body" assertion holds. */
function stripMcpSecrets(
  server: FakeMcpServer,
): Omit<FakeMcpServer, "env" | "headers" | "testOutcome"> {
  const { env: _env, headers: _headers, testOutcome: _t, ...safe } = server;
  return safe;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function headerValue(
  headers: HeadersInit | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === lower);
    return found?.[1];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string" || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function requireToggleBody(body: unknown): { name: string; enabled: boolean } {
  const record = body as { name?: unknown; enabled?: unknown };
  if (
    typeof record?.name !== "string" ||
    typeof record?.enabled !== "boolean"
  ) {
    throw new HttpError(400, { code: "bad_request" });
  }
  return { name: record.name, enabled: record.enabled };
}

/** Matches a single-segment `:name` template, returning the decoded param. */
function matchPath(
  path: string,
  template: string,
): { name: string } | undefined {
  const templateParts = template.split("/");
  const pathParts = path.split("/");
  if (templateParts.length !== pathParts.length) return undefined;
  let name = "";
  for (let i = 0; i < templateParts.length; i += 1) {
    const t = templateParts[i];
    const p = pathParts[i];
    if (t === ":name") {
      name = decodeURIComponent(p);
      continue;
    }
    if (t !== p) return undefined;
  }
  return { name };
}
