/**
 * The data hook + framework-free controller behind the skill setup panel
 * (spec 09). For ONE skill on ONE {@link HermesAdminTarget}, it:
 *
 * - parses the skill's declared setup requirements from its metadata
 *   ({@link parseSkillSetupRequirements});
 * - loads the live env listing (which secrets are configured, never their
 *   values) and the config tree (current non-secret values) through the
 *   {@link HermesAdminClient} — never a raw `fetch`;
 * - writes/clears secrets via `env.set`/`env.delete` and non-secret config via
 *   `config.set`/`config.delete`, routing every mutation through the shared
 *   cache invalidation + durable notification + gateway-lifecycle banner so the
 *   apply-timing copy ("restart Hermes" for a secret, "next session" for config)
 *   is honest and consistent with every other admin surface.
 *
 * SECRET SAFETY: the controller never stores a typed secret value in its own
 * state beyond passing it straight to `env.set`; on success it clears the draft
 * immediately. It never reveals an existing secret unless the user explicitly
 * asks (a `reveal()` action that returns the value to the caller for a one-time
 * field and is never logged). The snapshot it hands React carries no secret
 * value — only configured/preview booleans and display-safe config values.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import { createRustAdminFetch } from "./rust-transport";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import {
  parseSkillSetupRequirements,
  readConfigPath,
  type HermesConfigResult,
  type HermesEnvListing,
  type HermesSkillInfo,
  type HermesSkillSetupRequirements,
} from "./schemas";
import {
  buildSkillSetupModel,
  envConfiguredIndex,
  skillConfigPath,
  skillConfigPathSegments,
  type SkillSetupBadge,
  type SkillSetupModel,
} from "./skill-setup-view";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The wired-up foundation primitives one setup panel operates on, all bound to
 * the SAME target. Production builds this from a bridge connection; tests build
 * it from the fake-server harness. */
export type SkillSetupEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

export type SkillSetupStatusKind =
  | "loading" // first load in flight
  | "ready" // loaded
  | "error"; // the load failed

/** Everything the setup panel renders, plus the actions it invokes. A pure
 * projection of the controller's state. Carries NO secret value. */
export type SkillSetupState = {
  status: SkillSetupStatusKind;
  /** The skill this panel is for. */
  skill: string;
  /** The combined requirements + live-state model + status badge. */
  model: SkillSetupModel;
  /** The mode this panel targets, for the sandbox/full-mode context line. */
  mode?: HermesAdminMode;
  /** The profile this panel is bound to, surfaced for explicit targeting. */
  profile?: string;
  /** Keys (env names or config paths) with a write in flight. */
  pending: ReadonlySet<string>;
  /** The user-safe error message when a load or write fails. */
  error?: string;
  retryable: boolean;
  /** The gateway lifecycle banner snapshot. */
  lifecycle: GatewayLifecycleSnapshot;
  /** Durable admin notifications, newest last. */
  notifications: readonly AdminNotification[];
  /** Reloads env + config state from Hermes. */
  refresh: () => void;
  /** Sets/updates a secret env var. The value is passed straight to Hermes and
   * never retained in state. */
  setSecret: (name: string, value: string) => void;
  /** Deletes a secret env var. */
  deleteSecret: (name: string) => void;
  /** Reveals an existing secret's plaintext value for a one-time field. The
   * value is returned to the CALLER only; it is never logged or stored in the
   * snapshot. Resolves undefined when unset or on failure. */
  revealSecret: (name: string) => Promise<string | undefined>;
  /** Sets/updates a non-secret config value. */
  setConfig: (key: string, value: string) => void;
  /** Clears a non-secret config value back to its default. */
  deleteConfig: (key: string) => void;
  /** Dismisses a durable notification by id. */
  dismissNotification: (id: string) => void;
};

const EMPTY_REQUIREMENTS: HermesSkillSetupRequirements = Object.freeze({
  env: [],
  config: [],
});

/**
 * The framework-free controller. Holds the env/config load state for one skill
 * and notifies a single subscriber (the hook) on change. Extracted so the
 * secret-safety rules are testable without React.
 */
export class SkillSetupController {
  private readonly engine: SkillSetupEngine;
  private readonly skill: string;
  private readonly requirements: HermesSkillSetupRequirements;
  private status: SkillSetupStatusKind = "loading";
  private error?: string;
  private retryable = false;
  private envConfigured = new Map<
    string,
    { configured: boolean; preview?: string }
  >();
  private configValues = new Map<string, string | undefined>();
  private readonly pending = new Set<string>();
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: SkillSetupState;
  /** Fired after a successful save/delete so a host that owns a SEPARATE cache
   * (the Installed skills setup-overview) can refresh; this controller's own
   * cache already reloads via its `afterMutation` invalidation. */
  private onSaved?: () => void;

  constructor(engine: SkillSetupEngine, skill: string, skillRaw: unknown) {
    this.engine = engine;
    this.skill = skill;
    this.requirements = parseSkillSetupRequirements(skillRaw);
    this.lifecycleSnapshot = engine.lifecycle.getSnapshot();
    this.notifications = engine.cache.getNotifications();
    this.snapshot = this.buildSnapshot();

    this.unsubscribers.push(
      engine.cache.subscribeNotifications((next) => {
        this.notifications = next;
        this.recompute();
      }),
    );
    this.unsubscribers.push(
      engine.lifecycle.subscribe((next) => {
        this.lifecycleSnapshot = next;
        this.recompute();
      }),
    );
    // A config/env invalidation from any path refreshes our view.
    this.unsubscribers.push(
      engine.cache.subscribe("envConfig", () => {
        if (this.engine.cache.isStale("envConfig")) void this.load();
      }),
    );
    this.unsubscribers.push(
      engine.cache.subscribe("configTree", () => {
        if (this.engine.cache.isStale("configTree")) void this.load();
      }),
    );
  }

  getSnapshot(): SkillSetupState {
    return this.snapshot;
  }

  /** Keeps the host's post-save callback current without rebuilding the
   * controller (the controller is memoized on engine+skill). */
  setOnSaved(onSaved?: () => void): void {
    this.onSaved = onSaved;
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
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  /** Loads the env listing + config tree, seeding from cache first so a refresh
   * does not blank the panel. Stores results back into the cache so other
   * surfaces stay coherent. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const cachedEnv = this.engine.cache.get<HermesEnvListing>("envConfig");
    const cachedConfig =
      this.engine.cache.get<HermesConfigResult>("configTree");
    if (cachedEnv || cachedConfig) {
      if (cachedEnv) this.applyEnv(cachedEnv);
      if (cachedConfig) this.applyConfig(cachedConfig);
      this.status = "ready";
      this.recompute();
    } else {
      this.status = "loading";
      this.recompute();
    }

    try {
      const [envListing, configResult] = await Promise.all([
        this.engine.client.env.list(),
        this.engine.client.config.get(),
      ]);
      if (this.disposed || seq !== this.loadSeq) return;
      this.engine.cache.set("envConfig", envListing);
      this.engine.cache.set("configTree", configResult);
      this.applyEnv(envListing);
      this.applyConfig(configResult);
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from("GET /api/env", error);
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      // Keep any cached state on screen; only flip to a hard error with nothing.
      this.status =
        this.envConfigured.size > 0 || this.configValues.size > 0
          ? "ready"
          : "error";
      this.recompute();
    }
  }

  /** Sets/updates a secret. The value is forwarded to Hermes and NEVER retained
   * in controller state; on success we refresh (presence flips to configured).
   * On failure the safe error is surfaced and nothing about the value leaks. */
  async setSecret(name: string, value: string): Promise<void> {
    if (this.pending.has(name)) return;
    this.pending.add(name);
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.env.set(name, value);
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, name);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.pending.delete(name);
      await this.load();
      this.onSaved?.();
    } catch (error) {
      if (this.disposed) return;
      this.pending.delete(name);
      // The error endpoint string carries no value; HermesAdminError redacts its
      // own body preview.
      const adminError = HermesAdminError.from("PUT /api/env", error);
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  async deleteSecret(name: string): Promise<void> {
    if (this.pending.has(name)) return;
    this.pending.add(name);
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.env.delete(name);
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, name);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.pending.delete(name);
      await this.load();
      this.onSaved?.();
    } catch (error) {
      if (this.disposed) return;
      this.pending.delete(name);
      const adminError = HermesAdminError.from("DELETE /api/env", error);
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  /** Reveals a secret's plaintext value for a one-time field. Returns it to the
   * caller; does NOT store it in state or log it. */
  async revealSecret(name: string): Promise<string | undefined> {
    try {
      const result = await this.engine.client.env.reveal(name);
      return result.value;
    } catch {
      // A failed reveal must not leak anything; surface a generic, value-free
      // error and resolve undefined.
      if (!this.disposed) {
        this.error = "Could not reveal this value.";
        this.recompute();
      }
      return undefined;
    }
  }

  async setConfig(key: string, value: string): Promise<void> {
    const path = skillConfigPath(this.skill, key);
    if (this.pending.has(path)) return;
    this.pending.add(path);
    this.error = undefined;
    this.recompute();
    try {
      // Write by segments: a skill or config key containing a dot must not be
      // split into nested config keys (the read side already uses segments).
      const outcome = await this.engine.client.config.setValueAtSegments(
        skillConfigPathSegments(this.skill, key),
        value,
      );
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, key);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.pending.delete(path);
      await this.load();
      this.onSaved?.();
    } catch (error) {
      if (this.disposed) return;
      this.pending.delete(path);
      const adminError = HermesAdminError.from("PUT /api/config", error);
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  async deleteConfig(key: string): Promise<void> {
    const path = skillConfigPath(this.skill, key);
    if (this.pending.has(path)) return;
    this.pending.add(path);
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.config.deleteAtSegments(
        skillConfigPathSegments(this.skill, key),
      );
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, key);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.pending.delete(path);
      await this.load();
      this.onSaved?.();
    } catch (error) {
      if (this.disposed) return;
      this.pending.delete(path);
      const adminError = HermesAdminError.from("DELETE /api/config", error);
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  private applyEnv(listing: HermesEnvListing): void {
    this.envConfigured = envConfiguredIndex(listing.vars);
  }

  private applyConfig(result: HermesConfigResult): void {
    const next = new Map<string, string | undefined>();
    for (const requirement of this.requirements.config) {
      next.set(
        requirement.key,
        readConfigPath(
          result.config,
          skillConfigPathSegments(this.skill, requirement.key),
        ),
      );
    }
    this.configValues = next;
  }

  private buildSnapshot(): SkillSetupState {
    const model = buildSkillSetupModel(
      this.requirements,
      this.envConfigured,
      this.configValues,
    );
    return {
      status: this.status,
      skill: this.skill,
      model,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      pending: new Set(this.pending),
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refreshAction,
      setSecret: this.setSecretAction,
      deleteSecret: this.deleteSecretAction,
      revealSecret: this.revealSecretAction,
      setConfig: this.setConfigAction,
      deleteConfig: this.deleteConfigAction,
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
  private readonly setSecretAction = (name: string, value: string): void => {
    void this.setSecret(name, value);
  };
  private readonly deleteSecretAction = (name: string): void => {
    void this.deleteSecret(name);
  };
  private readonly revealSecretAction = (
    name: string,
  ): Promise<string | undefined> => this.revealSecret(name);
  private readonly setConfigAction = (key: string, value: string): void => {
    void this.setConfig(key, value);
  };
  private readonly deleteConfigAction = (key: string): void => {
    void this.deleteConfig(key);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/** Binds a {@link SkillSetupController} to React for one engine + skill. A null
 * engine yields a frozen unavailable-ish state without constructing a
 * controller. */
export function useSkillSetupController(
  engine: SkillSetupEngine | null,
  skill: string,
  skillRaw: unknown,
  onSaved?: () => void,
): SkillSetupState {
  const controller = useMemo(
    () => (engine ? new SkillSetupController(engine, skill, skillRaw) : null),
    // skillRaw identity changes with each list refresh; key on the skill name +
    // engine so we do not rebuild on every poll. The requirements are stable for
    // a given skill within a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, skill],
  );

  // Keep the post-save callback current without rebuilding the controller.
  useEffect(() => {
    controller?.setOnSaved(onSaved);
  }, [controller, onSaved]);

  const [snapshot, setSnapshot] = useState<SkillSetupState>(() =>
    controller ? controller.getSnapshot() : unavailableState(skill),
  );

  useEffect(() => {
    if (!controller) {
      setSnapshot(unavailableState(skill));
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
  }, [controller, skill]);

  return snapshot;
}

/** The state shown when there is no runtime to talk to. */
function unavailableState(skill: string): SkillSetupState {
  return {
    status: "error",
    skill,
    model: buildSkillSetupModel(EMPTY_REQUIREMENTS, new Map(), new Map()),
    pending: new Set<string>(),
    retryable: false,
    error: "Hermes is not running.",
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    refresh: () => {},
    setSecret: () => {},
    deleteSecret: () => {},
    revealSecret: () => Promise.resolve(undefined),
    setConfig: () => {},
    deleteConfig: () => {},
    dismissNotification: () => {},
  };
}

/** Production helper: derives the {@link SkillSetupEngine} from a live bridge
 * status for a chosen mode, returning null when that mode is not running.
 * Profile targeting is explicit via {@link adminTargetForMode}. */
export function useSkillSetupEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): SkillSetupEngine | null {
  const target = useMemo(
    () => (bridge ? adminTargetForMode(bridge, mode, profile) : undefined),
    [bridge, mode, profile],
  );
  const identity = target
    ? `${target.mode}:${target.profile}:${target.baseUrl}:${target.token}`
    : null;

  return useMemo(() => {
    if (!target) return null;
    const client = createHermesAdminClient(target, {
      fetch: createRustAdminFetch(target.mode),
    });
    const cache = new AdminStateCache(target);
    const lifecycle = new GatewayLifecycle(client, cache);
    return { target, client, cache, lifecycle };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity
  }, [identity]);
}

/** The all-in-one production hook: fetch bridge status, derive the engine for
 * the mode, and run the controller for one skill. The panel calls THIS; tests
 * prefer {@link useSkillSetupController} with a harness engine. */
export function useSkillSetup(
  skill: string,
  skillRaw: unknown,
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
  onSaved?: () => void,
): SkillSetupState {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();

  useEffect(() => {
    let cancelled = false;
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled) setBridge(status);
      })
      .catch(() => {
        // A bridge failure leaves bridge undefined -> null engine -> the
        // unavailable state, which is the right "Hermes not running" surface.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useSkillSetupEngine(bridge, mode, profile);
  return useSkillSetupController(engine, skill, skillRaw, onSaved);
}

// ---------------------------------------------------------------------------
// Section-level overview: load env + config ONCE for a mode and compute a setup
// badge for each installed skill, so the Installed skills list can show badges
// without firing a request per row.
// ---------------------------------------------------------------------------

/** The setup overview the Installed skills list consumes: a badge resolver and a
 * "has any declared setup" predicate, both derived from one shared env+config
 * load. */
export type SkillsSetupOverview = {
  /** Whether the overview has finished its first load (badges before this are
   * computed from declared requirements only, with no configured state). */
  loaded: boolean;
  /** The setup status badge for one skill, or undefined when the skill declares
   * no setup at all (so the row shows nothing rather than a misleading "Ready").
   */
  badgeFor: (skill: HermesSkillInfo) => SkillSetupBadge | undefined;
  /** Re-reads env + config from Hermes. The per-skill setup panel uses a
   * SEPARATE engine/cache, so an inline save there does not invalidate this
   * overview's cache; a host calls this after such a save to refresh the badges. */
  refresh: () => void;
};

/** Builds the badge resolver from a loaded env index + config tree. Pure; the
 * hook below wires it to the shared load. */
function makeBadgeResolver(
  envConfigured: Map<string, { configured: boolean; preview?: string }>,
  config: Record<string, unknown>,
): (skill: HermesSkillInfo) => SkillSetupBadge | undefined {
  return (skill) => {
    const requirements = parseSkillSetupRequirements(skill.raw);
    if (requirements.env.length === 0 && requirements.config.length === 0) {
      return undefined;
    }
    const configValues = new Map<string, string | undefined>();
    for (const requirement of requirements.config) {
      configValues.set(
        requirement.key,
        readConfigPath(
          config,
          skillConfigPathSegments(skill.name, requirement.key),
        ),
      );
    }
    return buildSkillSetupModel(requirements, envConfigured, configValues)
      .badge;
  };
}

/** Loads env + config once for a mode and returns a badge resolver. Reuses the
 * shared cache so it does not duplicate work the per-skill panel already did. */
export function useSkillsSetupOverview(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): SkillsSetupOverview {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();
  useEffect(() => {
    let cancelled = false;
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled) setBridge(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useSkillSetupEngine(bridge, mode, profile);
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState<{
    env: Map<string, { configured: boolean; preview?: string }>;
    config: Record<string, unknown>;
    loaded: boolean;
  }>({ env: new Map(), config: {}, loaded: false });

  useEffect(() => {
    if (!engine) {
      setData({ env: new Map(), config: {}, loaded: false });
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const [envListing, configResult] = await Promise.all([
          engine.client.env.list(),
          engine.client.config.get(),
        ]);
        if (cancelled) return;
        engine.cache.set("envConfig", envListing);
        engine.cache.set("configTree", configResult);
        setData({
          env: envConfiguredIndex(envListing.vars),
          config: configResult.config,
          loaded: true,
        });
      } catch {
        // A failed overview load leaves badges computed from declared
        // requirements only (everything reads as not-configured). No value leaks.
        if (!cancelled) {
          setData((prev) => ({ ...prev, loaded: true }));
        }
      }
    };
    void run();
    // Refresh when the shared cache marks env/config stale (a write elsewhere).
    const reload = () => void run();
    const offEnv = engine.cache.subscribe("envConfig", () => {
      if (engine.cache.isStale("envConfig")) reload();
    });
    const offConfig = engine.cache.subscribe("configTree", () => {
      if (engine.cache.isStale("configTree")) reload();
    });
    return () => {
      cancelled = true;
      offEnv();
      offConfig();
    };
  }, [engine, refreshKey]);

  const badgeFor = useMemo(
    () => makeBadgeResolver(data.env, data.config),
    [data],
  );

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  return { loaded: data.loaded, badgeFor, refresh };
}
