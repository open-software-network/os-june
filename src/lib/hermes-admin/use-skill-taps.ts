/**
 * The data hook + framework-free controller behind June's native Team skill taps
 * manager (admin surfaces spec 13). For ONE runtime/profile it owns the
 * list / add / remove lifecycle for custom GitHub skill taps, and the
 * search-within-a-tap flow that reuses the Skills Hub search/install endpoints.
 *
 * Taps have NO dashboard REST endpoints in the v2026.6.19 contract, so the
 * list/add/remove writes go through the narrow Tauri bridge commands
 * (`hermes_skill_tap_list` / `hermes_skill_tap_add` / `hermes_skill_tap_remove`),
 * with the `owner/repo` + path validated argument-safe on both sides. A tap's
 * skills, however, surface through the SAME hub search/install flow every other
 * surface uses: searching a selected tap calls `skills.hubSearch(query, source)`
 * scoped to the tap, and installing reuses `skills.hubInstall` as a background
 * action (so a tap install behaves identically to a hub install and refreshes the
 * installed inventory).
 *
 * Targeting is explicit: the mode selects the runtime (sandboxed vs unrestricted);
 * there is no first-connection fallback. The controller is unit-testable: a test
 * injects a fake `io` (list/add/remove + hub search/install) and drives the flows
 * with no Tauri and no rendering. The hook is a thin binding over it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hermesBridgeStatus,
  hermesSkillTapAdd,
  hermesSkillTapList,
  hermesSkillTapRemove,
  type HermesBridgeStatus,
  type HermesSkillTapDto,
  type HermesSkillTapListResult,
  type HermesSkillTapWriteResult,
} from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import { createRustAdminFetch } from "./rust-transport";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import type { HermesActionStatus, HermesHubSkillResult } from "./schemas";
import {
  hubResultMatchesTap,
  looksLikeGithubAuthError,
  normalizeTapPath,
  sortTaps,
  tapSearchSource,
  validateTapPath,
  validateTapRepo,
} from "./taps-view";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The bridge + hub I/O the controller needs, injectable so a test can drive it
 * with fakes and assert the add/remove + search/install wiring without a Tauri
 * runtime. */
export type SkillTapsIo = {
  list: () => Promise<HermesSkillTapListResult>;
  add: (repo: string, path?: string) => Promise<HermesSkillTapWriteResult>;
  remove: (repo: string) => Promise<HermesSkillTapWriteResult>;
  /** Searches the hub scoped to one tap's source. */
  hubSearch: (query: string, source: string) => Promise<HermesHubSkillResult[]>;
  /** Installs a skill by identifier. Returns the install outcome: the action
   * handle (when backgrounded) and the status (when the response carried one).
   * A `failed` status surfaces as an inline install failure. */
  hubInstall: (identifier: string) => Promise<{
    action?: string;
    result?: HermesActionStatus;
  }>;
};

/** Loading/availability status. A missing runtime ("unavailable") is not an error
 * and not empty. */
export type SkillTapsStatus = "unavailable" | "loading" | "ready" | "error";

/** Search status for the selected tap, distinct so the UI renders the right
 * surface (idle vs searching vs ready-empty vs error). */
export type TapSearchStatus = "idle" | "searching" | "ready" | "error";

/** Per-identifier tap-skill install state. */
export type TapInstallPhase = "idle" | "installing" | "done" | "failed";

export type TapInstallState = {
  identifier: string;
  phase: TapInstallPhase;
  error?: string;
};

/** The search-within-a-tap slice of the controller's state. */
export type TapSearchState = {
  /** The repo currently being searched, or undefined when none is selected. */
  repo?: string;
  status: TapSearchStatus;
  /** The query the controller searched (echoed for the input). */
  query: string;
  results: HermesHubSkillResult[];
  error?: string;
  retryable: boolean;
};

/** Everything the manager component renders plus the actions it invokes. */
export type SkillTapsState = {
  status: SkillTapsStatus;
  /** The configured taps, sorted by repo. */
  taps: HermesSkillTapDto[];
  mode?: HermesAdminMode;
  profile?: string;
  /** Repos with an add/remove in flight. */
  pending: ReadonlySet<string>;
  /** A user-safe error from a list/add/remove failure. */
  error?: string;
  retryable: boolean;
  /** True when the last failure looked like a GitHub rate-limit / auth problem,
   * so the UI can steer the user to the GITHUB_TOKEN setup. */
  needsGithubToken: boolean;
  /** The search-within-a-tap state. */
  search: TapSearchState;
  /** Per-identifier install state for a tap skill. */
  installs: ReadonlyMap<string, TapInstallState>;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  /** Reloads the configured taps from Hermes. */
  refresh: () => void;
  /** Adds a tap. `path` is the optional override; empty means the default. */
  addTap: (repo: string, path?: string) => Promise<void>;
  /** Removes a tap by repo. */
  removeTap: (repo: string) => Promise<void>;
  /** Selects a tap and searches its skills (empty query lists them all). */
  searchTap: (repo: string, query?: string) => void;
  /** Re-runs the current tap search. */
  refreshSearch: () => void;
  /** Clears the selected tap / search results. */
  clearSearch: () => void;
  /** Installs a tap skill by identifier (reuses the hub install flow). */
  installSkill: (result: HermesHubSkillResult) => void;
  /** Clears a terminal (done/failed) install state. */
  clearInstall: (identifier: string) => void;
  /** Validates a repo input without mutating. */
  validateRepo: (repo: string) => string | null;
  /** Validates a path input without mutating. */
  validatePath: (path: string) => string | null;
  dismissNotification: (id: string) => void;
};

let tapNotificationSeq = 0;

/** A durable, sentence-case change notice. Tap changes apply to new sessions
 * (Hermes reads the tap config + skill index at session start). */
function tapNotification(message: string, isError = false): AdminNotification {
  tapNotificationSeq += 1;
  return {
    id: `tap-${Date.now()}-${tapNotificationSeq}`,
    message,
    timing: "next-session",
    mutation: "config.set",
    at: Date.now(),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The framework-free controller. Holds the tap list + per-tap search/install
 * state for one runtime/profile and notifies a single subscriber (the hook).
 */
export class SkillTapsController {
  private readonly io: SkillTapsIo;
  private readonly mode: HermesAdminMode;
  private readonly profile: string | undefined;
  private readonly lifecycle?: GatewayLifecycle;
  private readonly cache?: AdminStateCache;
  private taps: HermesSkillTapDto[] = [];
  private status: SkillTapsStatus = "loading";
  private error?: string;
  private retryable = false;
  private needsGithubToken = false;
  private readonly pending = new Set<string>();
  private search: TapSearchState = {
    status: "idle",
    query: "",
    results: [],
    retryable: false,
  };
  private readonly installs = new Map<string, TapInstallState>();
  private notifications: AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private searchSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: SkillTapsState;

  constructor(
    io: SkillTapsIo,
    mode: HermesAdminMode,
    options: {
      profile?: string;
      lifecycle?: GatewayLifecycle;
      cache?: AdminStateCache;
    } = {},
  ) {
    this.io = io;
    this.mode = mode;
    this.profile = options.profile;
    this.lifecycle = options.lifecycle;
    this.cache = options.cache;
    this.lifecycleSnapshot =
      options.lifecycle?.getSnapshot() ?? CLEAN_LIFECYCLE;
    if (options.cache) {
      this.notifications = [...options.cache.getNotifications()];
      this.unsubscribers.push(
        options.cache.subscribeNotifications((next) => {
          this.notifications = [...next];
          this.recompute();
        }),
      );
    }
    if (options.lifecycle) {
      this.unsubscribers.push(
        options.lifecycle.subscribe((next) => {
          this.lifecycleSnapshot = next;
          this.recompute();
        }),
      );
    }
    this.snapshot = this.buildSnapshot();
  }

  getSnapshot(): SkillTapsState {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.loadSeq += 1;
    this.searchSeq += 1;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  /** Loads the configured taps. A CLI failure that looks like a GitHub auth /
   * rate-limit problem flips `needsGithubToken` so the UI can steer to setup. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    if (this.taps.length === 0) {
      this.status = "loading";
      this.recompute();
    }
    try {
      const result = await this.io.list();
      if (this.disposed || seq !== this.loadSeq) return;
      if (!result.ok) {
        // The CLI ran but reported a failure (e.g. not configured, or a token
        // problem). Surface the safe message and the token hint.
        this.error = result.message ?? "Could not list taps.";
        this.retryable = true;
        this.needsGithubToken = looksLikeGithubAuthError(result.message);
        this.status = this.taps.length > 0 ? "ready" : "error";
        this.recompute();
        return;
      }
      this.taps = sortTaps(result.taps);
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.needsGithubToken = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      this.error = safeMessage(error, "Could not list taps from Hermes.");
      this.retryable = true;
      this.status = this.taps.length > 0 ? "ready" : "error";
      this.recompute();
    }
  }

  /** Adds a tap after validating the repo + path. The validation runs here too
   * (defense in depth above the bridge's own validation) so an invalid value
   * never reaches the CLI. */
  async addTap(repo: string, path?: string): Promise<void> {
    const value = repo.trim();
    const repoError = validateTapRepo(value);
    if (repoError) {
      this.error = repoError;
      this.needsGithubToken = false;
      this.recompute();
      return;
    }
    const pathError = validateTapPath(path ?? "");
    if (pathError) {
      this.error = pathError;
      this.needsGithubToken = false;
      this.recompute();
      return;
    }
    if (this.pending.has(value)) return;
    this.pending.add(value);
    this.error = undefined;
    this.recompute();
    try {
      const result = await this.io.add(value, normalizeTapPath(path));
      if (this.disposed) return;
      this.pending.delete(value);
      if (!result.ok) {
        const message = result.message ?? `Could not add ${value}.`;
        this.error = message;
        this.needsGithubToken = looksLikeGithubAuthError(result.message);
        this.notifications = [
          ...this.notifications,
          tapNotification(message, true),
        ];
        this.recompute();
        return;
      }
      this.needsGithubToken = false;
      this.notifications = [
        ...this.notifications,
        tapNotification(
          `Added tap ${value}. Its skills are available to new sessions through the hub.`,
        ),
      ];
      this.lifecycle?.noteMutation("config.set");
      await this.load();
    } catch (error) {
      if (this.disposed) return;
      this.pending.delete(value);
      const message = safeMessage(error, `Could not add ${value}.`);
      this.error = message;
      this.notifications = [
        ...this.notifications,
        tapNotification(message, true),
      ];
      this.recompute();
    }
  }

  async removeTap(repo: string): Promise<void> {
    const value = repo.trim();
    if (validateTapRepo(value)) return; // never send an unsafe identifier
    if (this.pending.has(value)) return;
    this.pending.add(value);
    this.error = undefined;
    this.recompute();
    try {
      const result = await this.io.remove(value);
      if (this.disposed) return;
      this.pending.delete(value);
      if (!result.ok) {
        const message = result.message ?? `Could not remove ${value}.`;
        this.error = message;
        this.notifications = [
          ...this.notifications,
          tapNotification(message, true),
        ];
        this.recompute();
        return;
      }
      // Clear the search if it was scoped to the removed tap.
      if (this.search.repo === value) {
        this.search = {
          status: "idle",
          query: "",
          results: [],
          retryable: false,
        };
      }
      this.notifications = [
        ...this.notifications,
        tapNotification(`Removed tap ${value}. New sessions will not load it.`),
      ];
      this.lifecycle?.noteMutation("config.set");
      await this.load();
    } catch (error) {
      if (this.disposed) return;
      this.pending.delete(value);
      const message = safeMessage(error, `Could not remove ${value}.`);
      this.error = message;
      this.notifications = [
        ...this.notifications,
        tapNotification(message, true),
      ];
      this.recompute();
    }
  }

  /** Selects a tap and searches its skills through the hub, scoped to the tap's
   * source. Results are also filtered locally by the tap identifier as a safety
   * net, since the upstream source token shape is not pinned. */
  async searchTap(repo: string, query = ""): Promise<void> {
    const value = repo.trim();
    if (validateTapRepo(value)) return;
    const seq = ++this.searchSeq;
    this.search = {
      repo: value,
      status: "searching",
      query,
      results: this.search.repo === value ? this.search.results : [],
      retryable: false,
    };
    this.recompute();
    try {
      const all = await this.io.hubSearch(query.trim(), tapSearchSource(value));
      if (this.disposed || seq !== this.searchSeq) return;
      const results = all.filter((result) =>
        hubResultMatchesTap(result, value),
      );
      this.search = {
        repo: value,
        status: "ready",
        query,
        results,
        retryable: false,
      };
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.searchSeq) return;
      const adminError = HermesAdminError.from(
        "GET /api/skills/hub/search",
        error,
      );
      this.search = {
        repo: value,
        status: "error",
        query,
        results: [],
        error: adminError.safeMessage,
        retryable: adminError.retryable,
      };
      this.recompute();
    }
  }

  refreshSearch(): void {
    if (this.search.repo)
      void this.searchTap(this.search.repo, this.search.query);
  }

  clearSearch(): void {
    this.searchSeq += 1;
    this.search = {
      status: "idle",
      query: "",
      results: [],
      retryable: false,
    };
    this.recompute();
  }

  /** Installs a tap skill by identifier, reusing the hub install flow. On success
   * it raises the durable "applies next session" notification and advances the
   * shared lifecycle banner, exactly like a hub install. */
  async installSkill(result: HermesHubSkillResult): Promise<void> {
    const { identifier } = result;
    if (this.installs.get(identifier)?.phase === "installing") return;
    this.setInstall(identifier, { phase: "installing" });
    try {
      const outcome = await this.io.hubInstall(identifier);
      if (this.disposed) return;
      const status = outcome.result;
      if (status && status.state === "failed") {
        this.setInstall(identifier, {
          phase: "failed",
          error: status.error ?? `Could not install ${result.name}.`,
        });
        return;
      }
      this.cache?.afterMutation("skill.hubInstall", result.name || identifier);
      this.lifecycle?.noteMutation("skill.hubInstall");
      this.notifications = [
        ...this.notifications,
        tapNotification(
          `Installed ${result.name || identifier}. New sessions can use it.`,
        ),
      ];
      this.setInstall(identifier, { phase: "done" });
    } catch (error) {
      if (this.disposed) return;
      const adminError = HermesAdminError.from(
        "POST /api/skills/hub/install",
        error,
      );
      this.setInstall(identifier, {
        phase: "failed",
        error: adminError.safeMessage,
      });
    }
  }

  clearInstall(identifier: string): void {
    if (this.installs.delete(identifier)) this.recompute();
  }

  dismissNotification(id: string): void {
    if (this.cache) {
      this.cache.dismissNotification(id);
      return;
    }
    this.notifications = this.notifications.filter((note) => note.id !== id);
    this.recompute();
  }

  private setInstall(
    identifier: string,
    next: Omit<TapInstallState, "identifier">,
  ): void {
    this.installs.set(identifier, { identifier, ...next });
    this.recompute();
  }

  private buildSnapshot(): SkillTapsState {
    return {
      status: this.status,
      taps: this.taps,
      mode: this.mode,
      profile: this.profile,
      pending: new Set(this.pending),
      error: this.error,
      retryable: this.retryable,
      needsGithubToken: this.needsGithubToken,
      search: this.search,
      installs: new Map(this.installs),
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refreshAction,
      addTap: this.addTapAction,
      removeTap: this.removeTapAction,
      searchTap: this.searchTapAction,
      refreshSearch: this.refreshSearchAction,
      clearSearch: this.clearSearchAction,
      installSkill: this.installSkillAction,
      clearInstall: this.clearInstallAction,
      validateRepo: validateTapRepo,
      validatePath: validateTapPath,
      dismissNotification: this.dismissNotificationAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private readonly refreshAction = (): void => {
    void this.load();
  };
  private readonly addTapAction = (repo: string, path?: string) =>
    this.addTap(repo, path);
  private readonly removeTapAction = (repo: string) => this.removeTap(repo);
  private readonly searchTapAction = (repo: string, query?: string): void => {
    void this.searchTap(repo, query);
  };
  private readonly refreshSearchAction = (): void => {
    this.refreshSearch();
  };
  private readonly clearSearchAction = (): void => {
    this.clearSearch();
  };
  private readonly installSkillAction = (
    result: HermesHubSkillResult,
  ): void => {
    void this.installSkill(result);
  };
  private readonly clearInstallAction = (identifier: string): void => {
    this.clearInstall(identifier);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

const CLEAN_LIFECYCLE: GatewayLifecycleSnapshot = Object.freeze({
  state: "clean",
  label: "Up to date",
  detail: "No pending changes.",
  canRestart: false,
});

/** Binds a {@link SkillTapsController} to React. A null io yields the
 * "unavailable" state without constructing a controller. */
export function useSkillTapsController(
  io: SkillTapsIo | null,
  mode: HermesAdminMode,
  options: {
    profile?: string;
    lifecycle?: GatewayLifecycle;
    cache?: AdminStateCache;
  } = {},
): SkillTapsState {
  const { profile, lifecycle, cache } = options;
  const controller = useMemo(
    () =>
      io
        ? new SkillTapsController(io, mode, { profile, lifecycle, cache })
        : null,
    [io, mode, profile, lifecycle, cache],
  );

  const [snapshot, setSnapshot] = useState<SkillTapsState>(() =>
    controller ? controller.getSnapshot() : UNAVAILABLE_STATE,
  );

  useEffect(() => {
    if (!controller) {
      setSnapshot(UNAVAILABLE_STATE);
      return;
    }
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(() => {
      setSnapshot(controller.getSnapshot());
    });
    void controller.load();
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return snapshot;
}

/** The frozen state shown when there is no runtime to talk to. */
const UNAVAILABLE_STATE: SkillTapsState = Object.freeze({
  status: "unavailable",
  taps: [],
  pending: new Set<string>(),
  retryable: false,
  needsGithubToken: false,
  search: { status: "idle", query: "", results: [], retryable: false },
  installs: new Map<string, TapInstallState>(),
  lifecycle: CLEAN_LIFECYCLE,
  notifications: [],
  refresh: () => {},
  addTap: async () => {},
  removeTap: async () => {},
  searchTap: () => {},
  refreshSearch: () => {},
  clearSearch: () => {},
  installSkill: () => {},
  clearInstall: () => {},
  validateRepo: validateTapRepo,
  validatePath: validateTapPath,
  dismissNotification: () => {},
}) as SkillTapsState;

/**
 * Production hook: derives the bridge target for a mode, builds the Tauri + admin
 * io, and runs the controller. Returns the "unavailable" state when that mode is
 * not running. Profile targeting is explicit via {@link adminTargetForMode}.
 */
export function useSkillTaps(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): SkillTapsState {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();
  const [bridgeError, setBridgeError] = useState<string>();
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled) {
          setBridge(status);
          loaded.current = true;
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBridgeError(
            error instanceof Error ? error.message : String(error),
          );
          loaded.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const target = useMemo<HermesAdminTarget | undefined>(
    () => (bridge ? adminTargetForMode(bridge, mode, profile) : undefined),
    [bridge, mode, profile],
  );
  const identity = target
    ? `${target.mode}:${target.profile}:${target.baseUrl}:${target.token}`
    : null;

  const wiring = useMemo<{
    io: SkillTapsIo;
    cache: AdminStateCache;
    lifecycle: GatewayLifecycle;
  } | null>(() => {
    if (!target) return null;
    const requestProfile =
      target.profile && target.profile !== "default"
        ? target.profile
        : undefined;
    const client: HermesAdminClient = createHermesAdminClient(target, {
      fetch: createRustAdminFetch(target.mode),
    });
    const cache = new AdminStateCache(target);
    const lifecycle = new GatewayLifecycle(client, cache);
    const io: SkillTapsIo = {
      list: () =>
        hermesSkillTapList({ mode: target.mode, profile: requestProfile }),
      add: (repo, path) =>
        hermesSkillTapAdd({
          mode: target.mode,
          profile: requestProfile,
          repo,
          path,
        }),
      remove: (repo) =>
        hermesSkillTapRemove({
          mode: target.mode,
          profile: requestProfile,
          repo,
        }),
      hubSearch: (query, source) => client.skills.hubSearch(query, source),
      hubInstall: async (identifier) => {
        const outcome = await client.skills.hubInstall(identifier);
        return { action: outcome.action, result: outcome.result };
      },
    };
    return { io, cache, lifecycle };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity
  }, [identity]);

  const state = useSkillTapsController(wiring?.io ?? null, mode, {
    profile,
    lifecycle: wiring?.lifecycle,
    cache: wiring?.cache,
  });

  if (wiring === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}

function safeMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
