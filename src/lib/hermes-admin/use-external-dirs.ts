/**
 * The data hook behind June's native External skill directories manager
 * (spec 10). It owns the load / add / remove / refresh lifecycle for one
 * {@link HermesAdminTarget}, driving the shared admin foundation primitives:
 *
 * - {@link HermesAdminClient} `config.get()` for the configured
 *   `skills.external_dirs` list and `config.setValue()` to write the merged list
 *   through Hermes' REST surface (so the jailed dashboard owns the config.yaml
 *   write — no June-side EPERM / race), plus `skills.list()` to compute which
 *   external skills a local skill shadows;
 * - the June-side `hermesInspectExternalDirs` Tauri command for the read-only
 *   filesystem status (exists / readable / writable / discovered-skill count /
 *   `~`/`${VAR}` expansion) the dashboard does not report;
 * - {@link AdminStateCache} for the durable "applies next session" notification
 *   and the `configTree`/`skills` invalidation bus;
 * - {@link GatewayLifecycle} for the honest apply-timing banner (a config write
 *   is `next-session`, never "applied now").
 *
 * Split from the React component so the add/remove/validation behavior is
 * unit-testable against the fake Hermes server (config writes) with the
 * filesystem inspect injected, no rendering. Profile targeting is explicit: the
 * controller is built from ONE target's engine, so a write can only ever hit the
 * runtime that target names.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  hermesBridgeStatus,
  hermesInspectExternalDirs,
  type ExternalDirStatus,
  type HermesBridgeStatus,
} from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import { createRustAdminFetch } from "./rust-transport";
import {
  EXTERNAL_DIRS_CONFIG_PATH,
  readExternalDirs,
  type HermesSkillInfo,
} from "./schemas";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";
import {
  addDir,
  buildExternalDirRows,
  removeDir,
  validateNewDir,
  type ExternalDirRow,
} from "./external-dirs-view";

/** The dotted config path string the external dirs list is written to. */
const EXTERNAL_DIRS_PATH = EXTERNAL_DIRS_CONFIG_PATH.join(".");

/** The function that inspects the configured dirs read-only. Injectable so a
 * test can drive the rows without a Tauri runtime. */
export type InspectExternalDirs = (
  dirs: string[],
) => Promise<ExternalDirStatus[]>;

/** The wired-up foundation primitives this surface operates on, all bound to the
 * SAME target. Production builds this from a bridge connection; tests build it
 * from the fake-server harness and inject `inspect`. */
export type ExternalDirsEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
  /** The filesystem inspector. Production uses the Tauri command; tests inject
   * a stub so the labels can be asserted deterministically. */
  inspect: InspectExternalDirs;
};

/** Loading/availability status of the page. A missing runtime ("unavailable")
 * is NOT an error and NOT empty. */
export type ExternalDirsStatus = "unavailable" | "loading" | "ready" | "error";

/** Everything the External skill directories component renders, plus the actions
 * it invokes. A pure projection of the controller's internal state. */
export type ExternalDirsState = {
  status: ExternalDirsStatus;
  /** The joined rows (raw + resolved paths, status labels, shadowing), in the
   * configured order. */
  rows: ExternalDirRow[];
  /** The raw configured paths, for the add-validation dedupe. */
  rawDirs: string[];
  mode?: HermesAdminMode;
  profile?: string;
  /** True while a config write (add/remove) is in flight. */
  busy: boolean;
  /** The user-safe message when `status === "error"`, or a write failed. */
  error?: string;
  /** True when the failing load is worth retrying (network/5xx/timeout). */
  retryable: boolean;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  refresh: () => void;
  /** Adds a directory (validated, deduped) and writes the merged list. Returns
   * a validation error string when the input is rejected before any write. */
  add: (path: string) => Promise<string | undefined>;
  /** Removes a directory by its raw configured path and writes the merged list. */
  remove: (rawPath: string) => void;
  dismissNotification: (id: string) => void;
};

/**
 * The framework-free controller the hook wraps. Holds the mutable load/write
 * state for one engine and notifies a single subscriber (the hook) on change.
 */
export class ExternalDirsController {
  private readonly engine: ExternalDirsEngine;
  private rawDirs: string[] = [];
  private rows: ExternalDirRow[] = [];
  private localSkills: HermesSkillInfo[] = [];
  private status: ExternalDirsStatus = "loading";
  private error?: string;
  private retryable = false;
  private busy = false;
  private notifications: readonly AdminNotification[];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: ExternalDirsState;

  constructor(engine: ExternalDirsEngine) {
    this.engine = engine;
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
    // A configTree invalidation from ANY path (a config write elsewhere, a
    // profile switch) reloads the list so the page stays correct.
    this.unsubscribers.push(
      engine.cache.subscribe("configTree", () => {
        if (this.engine.cache.isStale("configTree")) {
          void this.load();
        }
      }),
    );
  }

  getSnapshot(): ExternalDirsState {
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
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  /** Loads the configured dirs, their filesystem status, and the local skill
   * list, then joins them into rows. Reads the config tree from Hermes, the
   * status from June's read-only inspector, and the skills from Hermes. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    if (this.rows.length === 0) {
      this.status = "loading";
      this.recompute();
    }

    try {
      // The config read is the source of truth for WHICH dirs are configured;
      // skills feed the shadowing math. Both come from Hermes. The filesystem
      // status comes from June's own process.
      const [config, skills] = await Promise.all([
        this.engine.client.config.get(),
        this.engine.client.skills.list().catch(() => [] as HermesSkillInfo[]),
      ]);
      if (this.disposed || seq !== this.loadSeq) return;

      const rawDirs = readExternalDirs(config.config);
      this.engine.cache.set("configTree", config.config);
      // Inspect is best-effort: a failure leaves rows with "unknown" status
      // rather than failing the page (the config list is still actionable).
      let statuses: ExternalDirStatus[] = [];
      try {
        statuses = rawDirs.length > 0 ? await this.engine.inspect(rawDirs) : [];
      } catch {
        statuses = [];
      }
      if (this.disposed || seq !== this.loadSeq) return;

      this.rawDirs = rawDirs;
      this.localSkills = skills;
      this.rows = buildExternalDirRows(rawDirs, statuses, skills);
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from("GET /api/config", error);
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      this.status = this.rows.length > 0 ? "ready" : "error";
      this.recompute();
    }
  }

  /** Adds a directory: validates, then read-merge-writes the list through
   * `config.setValue`. Returns a validation message when rejected (no write
   * happens); resolves undefined on a successful write. */
  async add(path: string): Promise<string | undefined> {
    const validation = validateNewDir(path, this.rawDirs);
    if (!validation.ok) {
      // Surface inline without raising a durable notification — it is a form
      // validation message, not a Hermes failure.
      this.error = validation.reason;
      this.recompute();
      return validation.reason;
    }
    const next = addDir(this.rawDirs, validation.value);
    await this.writeDirs(next, "external directories");
    return undefined;
  }

  /** Removes a directory by raw path and writes the merged list. */
  async remove(rawPath: string): Promise<void> {
    const next = removeDir(this.rawDirs, rawPath);
    // A no-op remove (path not present) still writes the identical list, which
    // is harmless; guard it anyway to avoid a pointless config write.
    if (next.length === this.rawDirs.length) return;
    await this.writeDirs(next, "external directories");
  }

  /** Writes the whole `skills.external_dirs` list through Hermes' REST config
   * mutation. On success applies the cache invalidation + durable notification
   * and advances the lifecycle banner, then reloads. On failure surfaces the
   * safe error; the on-screen list is unchanged (the write did not land). */
  private async writeDirs(next: string[], subject: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.config.setValue(
        EXTERNAL_DIRS_PATH,
        next,
      );
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, subject);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.busy = false;
      await this.load();
    } catch (error) {
      if (this.disposed) return;
      this.busy = false;
      const adminError = HermesAdminError.from("PUT /api/config", error);
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  private buildSnapshot(): ExternalDirsState {
    return {
      status: this.status,
      rows: this.rows,
      rawDirs: this.rawDirs,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      busy: this.busy,
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refresh,
      add: this.addAction,
      remove: this.removeAction,
      dismissNotification: this.dismissNotificationAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private readonly refresh = (): void => {
    void this.load();
  };
  private readonly addAction = (path: string): Promise<string | undefined> =>
    this.add(path);
  private readonly removeAction = (rawPath: string): void => {
    void this.remove(rawPath);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/** Binds an {@link ExternalDirsController} to React for one engine. A null
 * engine yields the "unavailable" state. */
export function useExternalDirsController(
  engine: ExternalDirsEngine | null,
): ExternalDirsState {
  const controller = useMemo(
    () => (engine ? new ExternalDirsController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<ExternalDirsState>(() =>
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
const UNAVAILABLE_STATE: ExternalDirsState = Object.freeze({
  status: "unavailable",
  rows: [],
  rawDirs: [],
  busy: false,
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  refresh: () => {},
  add: () => Promise.resolve(undefined),
  remove: () => {},
  dismissNotification: () => {},
}) as ExternalDirsState;

/**
 * Production helper: derives the {@link ExternalDirsEngine} from a live bridge
 * status for a chosen mode, returning null when that mode is not running.
 * Profile selection is explicit via {@link adminTargetForMode}. The filesystem
 * inspector defaults to the Tauri command; tests pass their own.
 */
export function useExternalDirsEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
  inspect: InspectExternalDirs = hermesInspectExternalDirs,
): ExternalDirsEngine | null {
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
    return { target, client, cache, lifecycle, inspect };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity
  }, [identity]);
}

/**
 * The all-in-one production hook: fetch bridge status once, derive the engine
 * for the given mode, and run the controller.
 */
export function useExternalDirs(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): ExternalDirsState {
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

  const engine = useExternalDirsEngine(bridge, mode, profile);
  const state = useExternalDirsController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
