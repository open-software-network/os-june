/**
 * The typed Hermes Admin API client — the keystone every June-native admin
 * surface (Skills, Toolsets, Skills Hub, MCP, gateway lifecycle, env writes,
 * diagnostics) calls instead of hand-writing `fetch("/api/...")`. It is built
 * from ONE explicit {@link HermesAdminTarget}: a profile/mode-sensitive write is
 * therefore always aimed at a chosen runtime, never at "whichever connection is
 * first". To target a different runtime you construct a different client with a
 * different target — there is no implicit fallback inside any method.
 *
 * Each method group maps to documented dashboard endpoints, parses responses
 * with the defensive validators in `./schemas`, normalizes failures to
 * {@link HermesAdminError}, and tags mutations with their application timing
 * (`./application-timing`) so callers can render the correct "applies now / next
 * session / restart required" semantics. Backgroundable endpoints return an
 * action handle that {@link HermesAdminClient.pollAction} drives to completion.
 */

import {
  requiresGatewayRestart,
  timingForMutation,
  type AdminMutation,
  type ApplicationTiming,
} from "./application-timing";
import { HermesAdminError } from "./errors";
import {
  parseActionHandle,
  parseActionStatus,
  parseConfigResult,
  parseConfigWriteResult,
  parseEnvListing,
  parseEnvRevealResult,
  parseEnvWriteResult,
  parseGatewayStatus,
  parseHubSearch,
  parseMcpCatalog,
  parseMcpServer,
  parseMcpServerList,
  parseMcpTestResult,
  parseProfileCreateResult,
  parseProfileList,
  parseProfileSessionList,
  parseSkillContent,
  parseSkillList,
  parseSkillScan,
  parseToggleResult,
  parseToolsetList,
  type HermesActionState,
  type HermesActionStatus,
  type HermesConfigResult,
  type HermesConfigWriteResult,
  type HermesEnvListing,
  type HermesEnvRevealResult,
  type HermesEnvWriteResult,
  type HermesGatewayStatus,
  type HermesHubSkillResult,
  type HermesMcpCatalogEntry,
  type HermesMcpServerInfo,
  type HermesMcpTestResult,
  type HermesProfileCreateResult,
  type HermesProfileSession,
  type HermesProfileSummary,
  type HermesSkillContent,
  type HermesSkillInfo,
  type HermesSkillScan,
  type HermesToggleResult,
  type HermesToolsetInfo,
} from "./schemas";
import {
  createAdminTransport,
  type AdminTransportOptions,
  type AdminTransport,
} from "./transport";
import type { HermesAdminTarget } from "./target";

/** A mutation result paired with WHEN it applies, so a caller never has to
 * remember the timing rule for an endpoint — it is returned with the result. */
export type MutationOutcome<T> = {
  /** Always true: an outcome is constructed only on a 2xx (the transport throws
   * a {@link HermesAdminError} on any non-2xx). Lets a UI distinguish
   * "succeeded, the server just omitted the object from its response" (where
   * `result` may be `undefined`) from a thrown failure, without inspecting
   * `result`. */
  ok: boolean;
  result: T;
  mutation: AdminMutation;
  appliesAt: ApplicationTiming;
  /** True when a gateway restart is needed before this change takes effect. */
  requiresRestart: boolean;
  /** The action handle to poll, when the endpoint backgrounded the work. */
  action?: string;
};

/** Options for {@link HermesAdminClient.pollAction}. */
export type PollActionOptions = {
  /** Poll interval in ms. */
  intervalMs?: number;
  /** Give up after this many ms and reject with a timeout-kind error. */
  timeoutMs?: number;
  /** Called after each poll with the latest status, for live progress UI. */
  onStatus?: (status: HermesActionStatus) => void;
  /** Injectable clock for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Abort signal to cancel polling (e.g. component unmount). */
  signal?: AbortSignal;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

/** Payload for `POST /api/mcp/servers`, matching the dashboard's
 * `MCPServerCreate` schema (v2026.6.19): `name` is required; `command`/`args`
 * describe a stdio server, `url`/`auth` an http(-oauth) server; `env` carries
 * secret config. NOTE: this Hermes version's create schema has NO tool
 * include/exclude/filter field, so MCP tool filtering is not configured here
 * (see the removed `setToolFilters` note below). Extra keys are tolerated by the
 * server but not part of the contract. */
export type HermesAddMcpServerPayload = {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  auth?: string;
  env?: Record<string, string>;
  profile?: string;
} & Record<string, unknown>;

/** Payload for `POST /api/mcp/catalog/install`, matching `MCPCatalogInstall`:
 * the required identifier field is `name` (NOT `id`); `env`/`enable` are
 * optional. */
export type HermesInstallCatalogPayload = {
  /** The catalog entry's identifier — the schema calls this `name`. */
  name: string;
  env?: Record<string, string>;
  enable?: boolean;
  profile?: string;
} & Record<string, unknown>;

/** Payload for `POST /api/profiles`, matching the dashboard's `ProfileCreate`
 * schema (v2026.6.19). `name` is the only required field. `clone_from_default`
 * seeds the new profile from June's default (so it inherits June's identity and
 * bundled skills unless `no_skills` is set); `keep_skills` narrows which bundled
 * skills survive; `hub_skills` installs optional hub skills at create time;
 * `mcp_servers` attaches MCP servers. `provider`/`model` set the generation
 * model. The SOUL/instructions are NOT part of this body — they are written
 * after create via `PUT /api/profiles/{name}/soul`. */
export type HermesCreateProfilePayload = {
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  clone_from?: string;
  clone_from_default?: boolean;
  clone_all?: boolean;
  no_skills?: boolean;
  keep_skills?: string[];
  hub_skills?: string[];
  mcp_servers?: HermesAddMcpServerPayload[];
} & Record<string, unknown>;

/**
 * The typed admin surface. A frozen object of method groups. Built by
 * {@link createHermesAdminClient}.
 */
export type HermesAdminClient = {
  /** The target this client manages. Exposes mode/profile so a caller can show
   * June's sandbox/full-mode context without re-deriving it. */
  readonly target: HermesAdminTarget;

  readonly skills: {
    list(): Promise<HermesSkillInfo[]>;
    toggle(
      name: string,
      enabled: boolean,
    ): Promise<MutationOutcome<HermesToggleResult>>;
    /** Reads a skill's raw SKILL.md text for the detail viewer/editor.
     * `GET /api/skills/content?name=&profile=`. */
    getContent(name: string): Promise<HermesSkillContent>;
    /** Rewrites a skill's SKILL.md (full replace). `PUT /api/skills/content`
     * with `SkillContentUpdate` (`{ name, content, profile? }`). The content is
     * validated by the caller BEFORE this is invoked; this only transports it.
     * Applies next session (the skill index/frontmatter is read at session
     * start), like {@link toggle}. */
    updateContent(
      name: string,
      content: string,
    ): Promise<MutationOutcome<HermesSkillContent>>;
    hubSearch(query: string, source?: string): Promise<HermesHubSkillResult[]>;
    /** Audits / re-scans an installed hub skill by identifier.
     * `GET /api/skills/hub/scan?identifier=`. Returns the scan verdict +
     * findings so June can surface "what running this skill entails" without
     * mutating anything. Read-only: applies immediately. */
    hubScan(identifier: string): Promise<HermesSkillScan>;
    /** Installs a skill by identifier. `force` is sent ONLY when explicitly
     * true (the user completed the security review); it is omitted otherwise so
     * a `force: true` can never leak in by default. */
    hubInstall(
      identifier: string,
      options?: { force?: boolean },
    ): Promise<MutationOutcome<HermesActionStatus | undefined>>;
    hubUninstall(
      name: string,
    ): Promise<MutationOutcome<HermesActionStatus | undefined>>;
    /** Updates installed hub skills. The dashboard's `SkillsUpdateRequest`
     * scopes by profile only (there is no per-skill name in the body), so
     * `subject` is used solely for the notification label, not sent. */
    hubUpdate(
      subject?: string,
    ): Promise<MutationOutcome<HermesActionStatus | undefined>>;
  };

  readonly toolsets: {
    list(): Promise<HermesToolsetInfo[]>;
    toggle(
      name: string,
      enabled: boolean,
    ): Promise<MutationOutcome<HermesToggleResult>>;
  };

  readonly mcp: {
    listServers(): Promise<HermesMcpServerInfo[]>;
    addServer(
      payload: HermesAddMcpServerPayload,
    ): Promise<MutationOutcome<HermesMcpServerInfo | undefined>>;
    testServer(name: string): Promise<MutationOutcome<HermesMcpTestResult>>;
    setEnabled(
      name: string,
      enabled: boolean,
    ): Promise<MutationOutcome<HermesToggleResult>>;
    removeServer(name: string): Promise<MutationOutcome<{ ok: boolean }>>;
    // NOTE: no setToolFilters. The v2026.6.19 dashboard exposes no
    // `PUT /api/mcp/servers/{name}/tools` endpoint, and `MCPServerCreate`
    // carries no include/exclude/filter field, so per-tool filtering is not
    // configurable through this contract. Track 16 owns whatever filtering UI
    // emerges; if a future Hermes adds the field, it goes on the create body.
    catalog(): Promise<HermesMcpCatalogEntry[]>;
    installCatalogEntry(
      payload: HermesInstallCatalogPayload,
    ): Promise<MutationOutcome<HermesActionStatus | undefined>>;
  };

  readonly profiles: {
    /** Lists the Hermes profiles. `GET /api/profiles`. Used by the builder to
     * dedupe the new profile's name/slug against existing ones and to offer a
     * clone source. NOT profile-scoped — it lists ALL profiles. */
    list(): Promise<HermesProfileSummary[]>;
    /** Creates a profile. `POST /api/profiles` with `ProfileCreate`. NOT
     * profile-scoped (it creates a new profile; the active-profile query would
     * be meaningless). Applies next session — the new profile is available to
     * sessions started under it, it does not alter the running gateway. */
    create(
      payload: HermesCreateProfilePayload,
    ): Promise<MutationOutcome<HermesProfileCreateResult>>;
    /** Writes a profile's SOUL/instructions. `PUT /api/profiles/{name}/soul`
     * with `ProfileSoulUpdate` (`{ content }`). Called after create when the
     * builder collected a custom SOUL. */
    setSoul(
      name: string,
      content: string,
    ): Promise<MutationOutcome<{ ok: boolean }>>;
    /** Lists live/recent profile sessions. `GET /api/profiles/sessions`. The
     * builder polls this to confirm a started test session is running. */
    sessions(): Promise<HermesProfileSession[]>;
    /** Starts a test session for a profile by making it active and opening a
     * terminal. `POST /api/profiles/active` then
     * `POST /api/profiles/{name}/open-terminal`. */
    startTestSession(name: string): Promise<MutationOutcome<{ ok: boolean }>>;
  };

  readonly gateway: {
    status(): Promise<HermesGatewayStatus>;
    restart(): Promise<MutationOutcome<HermesActionStatus | undefined>>;
    start(): Promise<MutationOutcome<HermesActionStatus | undefined>>;
    stop(): Promise<MutationOutcome<HermesActionStatus | undefined>>;
  };

  readonly actions: {
    status(actionName: string): Promise<HermesActionStatus>;
  };

  readonly env: {
    /** Lists configured env vars for the target profile. Values are masked by
     * the dashboard (only presence/metadata); the real value is read on demand
     * via {@link reveal}. `GET /api/env`. */
    list(): Promise<HermesEnvListing>;
    /** `PUT /api/env` with `{ key, value, profile? }` (`EnvVarUpdate`). The
     * value is write-only from June and is never logged. */
    set(
      key: string,
      value: string,
    ): Promise<MutationOutcome<HermesEnvWriteResult>>;
    /** `DELETE /api/env` with `{ key, profile? }` (`EnvVarDelete`). The key is
     * in the BODY, not the path. */
    delete(key: string): Promise<MutationOutcome<HermesEnvWriteResult>>;
    /** Reveals a single env var's plaintext value. `POST /api/env/reveal` with
     * `{ key, profile? }`. The returned value is a SECRET: it is returned to the
     * caller but never logged (the transport's logger is disabled for this
     * call). Track 09's secret-setup UI consumes this. */
    reveal(key: string): Promise<HermesEnvRevealResult>;
  };

  readonly config: {
    /** Reads the config tree for the target profile. `GET /api/config`. A caller
     * reads a dotted path (e.g. `skills.config.<skill>.<key>`) out of the
     * result. Non-secret: skill config is not sensitive, so values ARE returned
     * here (unlike env). */
    get(): Promise<HermesConfigResult>;
    /** Writes a single dotted config path. `PUT /api/config` with
     * `{ path, value, profile? }`. Used for non-secret skill config under
     * `skills.config`; applies next session (the runtime reads config at session
     * start). */
    set(
      path: string,
      value: string,
    ): Promise<MutationOutcome<HermesConfigWriteResult>>;
    /** Writes a non-scalar config value (an array or object) at a dotted path.
     * `PUT /api/config` with `{ path, value, profile? }`, where `value` is the
     * whole structure (e.g. the full `skills.external_dirs` list). The external
     * skill directories manager uses this to write the list it has already
     * read-merged client-side. Routes the write through Hermes' REST surface so
     * the jailed dashboard owns the `config.yaml` write (no June-side EPERM). */
    setValue(
      path: string,
      value: unknown,
    ): Promise<MutationOutcome<HermesConfigWriteResult>>;
    /** Segment-aware variant of {@link set}/{@link setValue}: writes `value` at
     * the exact path SEGMENTS, so a dynamic segment (a skill or MCP server name)
     * that itself contains a dot is written as ONE key, not mis-split into nested
     * keys. Use with `skillConfigPathSegments` / `toolsConfigPath`. */
    setValueAtSegments(
      segments: string[],
      value: unknown,
    ): Promise<MutationOutcome<HermesConfigWriteResult>>;
    /** Clears a single dotted config path back to its default. `DELETE
     * /api/config` with `{ path, profile? }` (the path is in the BODY). */
    delete(path: string): Promise<MutationOutcome<HermesConfigWriteResult>>;
    /** Segment-aware variant of {@link delete} (see {@link setValueAtSegments}). */
    deleteAtSegments(
      segments: string[],
    ): Promise<MutationOutcome<HermesConfigWriteResult>>;
  };

  /**
   * Drives a backgrounded action to a terminal state by polling
   * `/api/actions/{name}/status`. Resolves with the final status (which may be
   * `failed` — inspect `status.state`); rejects only on transport failure,
   * timeout, or abort. Used by the cache/lifecycle layer after hub installs and
   * gateway restarts.
   */
  pollAction(
    actionName: string,
    options?: PollActionOptions,
  ): Promise<HermesActionStatus>;
};

/** Builds a typed admin client bound to one target. */
export function createHermesAdminClient(
  target: HermesAdminTarget,
  options: AdminTransportOptions = {},
): HermesAdminClient {
  const send = createAdminTransport(target, options);

  return Object.freeze({
    target,
    skills: makeSkills(send),
    toolsets: makeToolsets(send),
    mcp: makeMcp(send),
    profiles: makeProfiles(send),
    gateway: makeGateway(send),
    actions: {
      status(actionName: string) {
        return send(
          {
            method: "GET",
            path: `/api/actions/${encodeURIComponent(actionName)}/status`,
          },
          (raw) => parseActionStatus(actionName, raw),
        );
      },
    },
    env: makeEnv(send),
    config: makeConfig(send),
    pollAction(actionName: string, pollOptions: PollActionOptions = {}) {
      return pollAction(send, actionName, pollOptions);
    },
  });
}

/** Wraps a mutation result with its timing metadata. Only ever called on a 2xx
 * (the transport throws on non-2xx), so `ok` is unconditionally true here. */
function outcome<T>(
  mutation: AdminMutation,
  result: T,
  action?: string,
): MutationOutcome<T> {
  return {
    ok: true,
    result,
    mutation,
    appliesAt: timingForMutation(mutation),
    requiresRestart: requiresGatewayRestart(mutation),
    action,
  };
}

function makeSkills(send: AdminTransport): HermesAdminClient["skills"] {
  return {
    list() {
      return send({ method: "GET", path: "/api/skills" }, parseSkillList);
    },
    async toggle(name, enabled) {
      const result = await send(
        {
          method: "PUT",
          path: "/api/skills/toggle",
          body: { name, enabled },
        },
        (raw) => parseToggleResult(name, enabled, raw),
      );
      return outcome("skill.toggle", result);
    },
    getContent(name) {
      return send(
        {
          method: "GET",
          path: "/api/skills/content",
          query: { name },
        },
        parseSkillContent,
      );
    },
    async updateContent(name, content) {
      // SkillContentUpdate is `{ name, content, profile? }`; the profile rides
      // the query param the transport injects for every call, so it is not
      // duplicated in the body. The body is never logged at info level (the
      // transport redacts), but SKILL.md is non-secret content anyway.
      const result = await send(
        {
          method: "PUT",
          path: "/api/skills/content",
          body: { name, content },
        },
        parseSkillContent,
      );
      return outcome("skill.editContent", result);
    },
    hubSearch(query, source) {
      return send(
        {
          method: "GET",
          path: "/api/skills/hub/search",
          query: { q: query, source },
        },
        parseHubSearch,
      );
    },
    hubScan(identifier) {
      // GET /api/skills/hub/scan?identifier=<id>. The dashboard contract types
      // the body loosely (`{}`); parse it through the same defensive scan parser
      // the install review uses, defaulting to an `unknown` verdict when the
      // wire carries nothing scan-shaped rather than asserting "safe".
      return send(
        {
          method: "GET",
          path: "/api/skills/hub/scan",
          query: { identifier },
        },
        (raw) =>
          parseSkillScan(raw) ?? {
            verdict: "unknown",
            raw,
          },
      );
    },
    async hubInstall(identifier, options) {
      // SkillInstallRequest is `{ identifier, profile?, force? }`. `force` rides
      // the body ONLY when the caller explicitly opts in (after the security
      // review); it is omitted entirely otherwise so a default install can never
      // carry `force: true`.
      const action = await send(
        {
          method: "POST",
          path: "/api/skills/hub/install",
          body: options?.force ? { identifier, force: true } : { identifier },
        },
        actionFromMutationResponse,
      );
      return outcome("skill.hubInstall", action, action?.action);
    },
    async hubUninstall(name) {
      const action = await send(
        { method: "POST", path: "/api/skills/hub/uninstall", body: { name } },
        actionFromMutationResponse,
      );
      return outcome("skill.hubUninstall", action, action?.action);
    },
    async hubUpdate(_subject) {
      // SkillsUpdateRequest scopes by profile only (no per-skill name field);
      // the update applies to all installed hub skills in the profile. The
      // `_subject` arg is for the caller's notification label, not the body.
      const action = await send(
        { method: "POST", path: "/api/skills/hub/update", body: {} },
        actionFromMutationResponse,
      );
      return outcome("skill.hubUpdate", action, action?.action);
    },
  };
}

function makeToolsets(send: AdminTransport): HermesAdminClient["toolsets"] {
  return {
    list() {
      return send(
        { method: "GET", path: "/api/tools/toolsets" },
        parseToolsetList,
      );
    },
    async toggle(name, enabled) {
      const result = await send(
        {
          method: "PUT",
          path: `/api/tools/toolsets/${encodeURIComponent(name)}`,
          body: { enabled },
        },
        (raw) => parseToggleResult(name, enabled, raw),
      );
      return outcome("toolset.toggle", result);
    },
  };
}

function makeMcp(send: AdminTransport): HermesAdminClient["mcp"] {
  return {
    listServers() {
      return send(
        { method: "GET", path: "/api/mcp/servers" },
        parseMcpServerList,
      );
    },
    async addServer(payload) {
      const result = await send(
        { method: "POST", path: "/api/mcp/servers", body: payload },
        parseMcpServer,
      );
      return outcome("mcp.add", result);
    },
    async testServer(name) {
      // Returned as a MutationOutcome (like its siblings) so callers get the
      // application timing and the `ok` signal, and so a successful test routes
      // through the same cache rule (mcp.test invalidates servers + toolsets).
      // The transport throwing on non-2xx is separate from the PROBE result:
      // `outcome.ok` means the request landed; `result.ok` means the probe
      // connected.
      const result = await send(
        {
          method: "POST",
          path: `/api/mcp/servers/${encodeURIComponent(name)}/test`,
        },
        (raw) => parseMcpTestResult(name, raw),
      );
      return outcome("mcp.test", result);
    },
    async setEnabled(name, enabled) {
      const result = await send(
        {
          method: "PUT",
          path: `/api/mcp/servers/${encodeURIComponent(name)}/enabled`,
          body: { enabled },
        },
        (raw) => parseToggleResult(name, enabled, raw),
      );
      return outcome("mcp.setEnabled", result);
    },
    async removeServer(name) {
      const result = await send(
        {
          method: "DELETE",
          path: `/api/mcp/servers/${encodeURIComponent(name)}`,
        },
        (raw) => ({ ok: okFrom(raw) }),
      );
      return outcome("mcp.remove", result);
    },
    catalog() {
      return send({ method: "GET", path: "/api/mcp/catalog" }, parseMcpCatalog);
    },
    async installCatalogEntry(payload) {
      const action = await send(
        { method: "POST", path: "/api/mcp/catalog/install", body: payload },
        actionFromMutationResponse,
      );
      return outcome("mcp.installCatalog", action, action?.action);
    },
  };
}

function makeProfiles(send: AdminTransport): HermesAdminClient["profiles"] {
  return {
    list() {
      // Lists ALL profiles — not scoped to the active one.
      return send(
        { method: "GET", path: "/api/profiles", scopeToProfile: false },
        parseProfileList,
      );
    },
    async create(payload) {
      // Create is global (it makes a new profile); the active-profile query is
      // meaningless here, so it opts out of profile scoping. The body carries no
      // secret-shaped fields (model/skill ids, not keys); MCP env values, if
      // any, are redacted by the transport's structural sanitizer.
      const result = await send(
        {
          method: "POST",
          path: "/api/profiles",
          body: payload,
          scopeToProfile: false,
        },
        (raw) => parseProfileCreateResult(payload.name, raw),
      );
      return outcome("profile.create", result);
    },
    async setSoul(name, content) {
      const result = await send(
        {
          method: "PUT",
          path: `/api/profiles/${encodeURIComponent(name)}/soul`,
          body: { content },
          scopeToProfile: false,
        },
        (raw) => ({ ok: okFrom(raw) }),
      );
      return outcome("profile.setSoul", result);
    },
    sessions() {
      return send(
        {
          method: "GET",
          path: "/api/profiles/sessions",
          scopeToProfile: false,
        },
        parseProfileSessionList,
      );
    },
    async startTestSession(name) {
      // Make the new profile active, then open a terminal session under it. Both
      // are global profile operations, so neither is profile-query-scoped.
      const activated = await send(
        {
          method: "POST",
          path: "/api/profiles/active",
          body: { name },
          scopeToProfile: false,
        },
        (raw) => ({ ok: okFrom(raw) }),
      );
      // Stop if the switch failed (a body-level { ok: false } on a 2xx):
      // opening a terminal would run under the wrong profile and falsely report
      // success. Surface the failure through the same outcome, matching create.
      if (!activated.ok) {
        return outcome("profile.create", activated);
      }
      const result = await send(
        {
          method: "POST",
          path: `/api/profiles/${encodeURIComponent(name)}/open-terminal`,
          scopeToProfile: false,
        },
        (raw) => ({ ok: okFrom(raw) }),
      );
      // Reuse the create timing/notification surface — starting a session is the
      // immediate consequence of a create, so the caller treats it as part of
      // the create flow rather than a distinct durable mutation.
      return outcome("profile.create", result);
    },
  };
}

function makeGateway(send: AdminTransport): HermesAdminClient["gateway"] {
  // Gateway lifecycle is not profile-scoped — it acts on the single runtime
  // process — so these opt out of the profile query.
  const lifecycle = (
    mutation: Extract<AdminMutation, "gateway.restart">,
    path: string,
  ) =>
    async function run() {
      const action = await send(
        { method: "POST", path, scopeToProfile: false },
        actionFromMutationResponse,
      );
      return outcome(mutation, action, action?.action);
    };

  return {
    status() {
      return send(
        { method: "GET", path: "/api/status", scopeToProfile: false },
        parseGatewayStatus,
      );
    },
    restart: lifecycle("gateway.restart", "/api/gateway/restart"),
    // start/stop share the restart timing (immediate once complete); they are
    // distinct endpoints the lifecycle UI may call directly.
    async start() {
      const action = await send(
        { method: "POST", path: "/api/gateway/start", scopeToProfile: false },
        actionFromMutationResponse,
      );
      return outcome("gateway.restart", action, action?.action);
    },
    async stop() {
      const action = await send(
        { method: "POST", path: "/api/gateway/stop", scopeToProfile: false },
        actionFromMutationResponse,
      );
      return outcome("gateway.restart", action, action?.action);
    },
  };
}

function makeEnv(send: AdminTransport): HermesAdminClient["env"] {
  return {
    list() {
      // GET /api/env (profile via the centrally-added ?profile= query).
      return send({ method: "GET", path: "/api/env" }, parseEnvListing);
    },
    async set(key, value) {
      // PUT /api/env with EnvVarUpdate { key, value }; profile rides the query.
      const result = await send(
        { method: "PUT", path: "/api/env", body: { key, value } },
        (raw) => parseEnvWriteResult(key, raw),
      );
      return outcome("env.set", result);
    },
    async delete(key) {
      // DELETE /api/env with EnvVarDelete { key } in the BODY (not the path).
      const result = await send(
        { method: "DELETE", path: "/api/env", body: { key } },
        (raw) => parseEnvWriteResult(key, raw),
      );
      return outcome("env.delete", result);
    },
    reveal(key) {
      // POST /api/env/reveal with EnvVarReveal { key }. The response carries the
      // plaintext SECRET, so this request is `silent`: never logged.
      return send(
        {
          method: "POST",
          path: "/api/env/reveal",
          body: { key },
          silent: true,
        },
        (raw) => parseEnvRevealResult(key, raw),
      );
    },
  };
}

/** Sets a value at the given path SEGMENTS on a config tree in place, creating
 * intermediate objects as needed. Replaces any non-object node in the way.
 * Segments (not a dotted string) so a dynamic key that itself contains a dot —
 * a skill or MCP server name — is written as ONE key, never split. */
function setConfigAtPath(
  tree: Record<string, unknown>,
  segments: string[],
  value: unknown,
): void {
  let node = tree;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i]!;
    const next = node[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
}

/** Deletes a value at the given path SEGMENTS from a config tree in place. No-op
 * if any segment is missing. Segment-based for the same dotted-name reason as
 * {@link setConfigAtPath}. */
function deleteConfigAtPath(
  tree: Record<string, unknown>,
  segments: string[],
): void {
  let node = tree;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const next = node[segments[i]!];
    if (typeof next !== "object" || next === null || Array.isArray(next))
      return;
    node = next as Record<string, unknown>;
  }
  delete node[segments[segments.length - 1]!];
}

function makeConfig(send: AdminTransport): HermesAdminClient["config"] {
  // Hermes' `PUT /api/config` (`ConfigUpdate`) takes the WHOLE config object
  // and `save_config` replaces the tree (only env-ref templates are preserved),
  // and there is NO `DELETE /api/config` route. So every write is a
  // read-modify-write: GET the tree, change one dotted path, PUT it back under
  // `{ config }`. This is why a `{ path, value }` body fails with a 422.
  async function writePath(
    label: "config.set" | "config.delete",
    path: string,
    apply: (tree: Record<string, unknown>) => void,
  ): Promise<MutationOutcome<HermesConfigWriteResult>> {
    const current = await send(
      { method: "GET", path: "/api/config" },
      parseConfigResult,
    );
    const next = structuredClone(current.config);
    apply(next);
    const result = await send(
      { method: "PUT", path: "/api/config", body: { config: next } },
      (raw) => parseConfigWriteResult(path, raw),
    );
    return outcome(label, result);
  }

  return {
    get() {
      // GET /api/config (profile via the centrally-added ?profile= query).
      return send({ method: "GET", path: "/api/config" }, parseConfigResult);
    },
    async set(path, value) {
      // Read-modify-write a single dotted path. Skill config is non-secret, but
      // the value is still not logged — the structural sanitizer masks any
      // credential-shaped value defensively. A dotted string is safe here only
      // because every caller of `set` uses a STATIC path (no dynamic name);
      // dynamic-name writers must use `setValueAtSegments` instead.
      const segments = path.split(".");
      return writePath("config.set", path, (tree) =>
        setConfigAtPath(tree, segments, value),
      );
    },
    async setValue(path, value) {
      // Same read-modify-write as `set`, but `value` is an arbitrary structure
      // (array/object) rather than a string. Used by the external directories
      // manager to write the whole `skills.external_dirs` list (a static path).
      const segments = path.split(".");
      return writePath("config.set", path, (tree) =>
        setConfigAtPath(tree, segments, value),
      );
    },
    async setValueAtSegments(segments, value) {
      // Segment-aware write: a skill or MCP server name may contain a dot, so a
      // dotted path would mis-nest it. Callers pass discrete segments
      // (skillConfigPathSegments / toolsConfigPath) so the value lands under the
      // exact key Hermes reads it from.
      return writePath("config.set", segments.join("."), (tree) =>
        setConfigAtPath(tree, segments, value),
      );
    },
    async delete(path) {
      // Clears a dotted path. Hermes has no DELETE /api/config, so this is a
      // read-modify-write that removes the key and PUTs the tree back.
      const segments = path.split(".");
      return writePath("config.delete", path, (tree) =>
        deleteConfigAtPath(tree, segments),
      );
    },
    async deleteAtSegments(segments) {
      // Segment-aware variant of `delete` (see `setValueAtSegments`).
      return writePath("config.delete", segments.join("."), (tree) =>
        deleteConfigAtPath(tree, segments),
      );
    },
  };
}

/** Parses a mutation response that MAY return an action handle into an
 * {@link HermesActionStatus} when it does, or `undefined` for a synchronous
 * mutation (no handle). */
function actionFromMutationResponse(
  raw: unknown,
): HermesActionStatus | undefined {
  const handle = parseActionHandle(raw);
  if (!handle) return undefined;
  // Seed an initial status from the same body; the caller polls from here.
  return parseActionStatus(handle, raw);
}

/** Reads a truthy `ok`/`success` from a delete-style ack; a bare 2xx is ok. */
function okFrom(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (typeof record.ok === "boolean") return record.ok;
    if (typeof record.success === "boolean") return record.success;
  }
  return true;
}

async function pollAction(
  send: AdminTransport,
  actionName: string,
  options: PollActionOptions,
): Promise<HermesActionStatus> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const endpoint = `GET /api/actions/${actionName}/status`;
  const deadline = Date.now() + timeoutMs;

  // Terminal states stop the loop; everything else keeps polling.
  const terminal: ReadonlySet<HermesActionState> = new Set([
    "succeeded",
    "failed",
  ]);

  for (;;) {
    if (options.signal?.aborted) {
      throw new HermesAdminError({ endpoint, kind: "timeout" });
    }
    const status = await send(
      {
        method: "GET",
        path: `/api/actions/${encodeURIComponent(actionName)}/status`,
      },
      (raw) => parseActionStatus(actionName, raw),
    );
    options.onStatus?.(status);
    if (status.done || terminal.has(status.state)) return status;

    if (Date.now() + intervalMs > deadline) {
      throw new HermesAdminError({
        endpoint,
        kind: "timeout",
        safeMessage: "Timed out waiting for Hermes to finish.",
      });
    }
    await sleep(intervalMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
