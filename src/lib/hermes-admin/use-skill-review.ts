/**
 * The data hook behind June's agent-managed skill write review queue (admin
 * surfaces spec 12). It owns two distinct data sources, kept honest together:
 *
 * - the PENDING WRITES themselves, read from the version-gated Rust command
 *   `hermes_pending_skill_writes` (the dashboard REST surface exposes no queue
 *   endpoint in v2026.6.19, so June reads the staged manifests directly through
 *   Rust); approve/reject route through `hermes_resolve_pending_skill_write`.
 * - the WRITE-APPROVAL GATE (`skills.write_approval`), read and written through
 *   the foundation {@link HermesAdminClient} `config` group, so the toggle hits
 *   the chosen runtime explicitly and its "applies next session" timing flows
 *   through the same shared cache + lifecycle every admin surface uses.
 *
 * Split from the React component so the load / approve / reject / toggle-gate
 * behavior is unit-testable with an injected `invoke` and a fake-server admin
 * client, no rendering required.
 *
 * Profile/mode targeting is explicit: the gate writes through ONE target's
 * client, and the Rust command receives the explicit `mode`, so neither can hit
 * "whichever connection is first". A missing runtime renders the unavailable
 * state rather than guessing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke as tauriInvoke, hermesBridgeStatus } from "../tauri";
import type { HermesBridgeStatus } from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import { createRustAdminFetch } from "./rust-transport";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import {
  parsePendingSkillWrites,
  readWriteApproval,
  WRITE_APPROVAL_PATH,
  type PendingSkillWrite,
} from "./skill-review-view";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The Tauri commands this hook calls. */
export const PENDING_SKILL_WRITES_COMMAND = "hermes_pending_skill_writes";
export const RESOLVE_PENDING_SKILL_WRITE_COMMAND =
  "hermes_resolve_pending_skill_write";

/** The injectable `invoke` surface (so tests need no Tauri runtime). */
export type ReviewInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** The wired-up primitives one review queue operates on, bound to ONE target. */
export type SkillReviewEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
  /** Routes pending-write reads/resolutions through Rust. */
  invoke: ReviewInvoke;
};

export type SkillReviewStatus =
  | "unavailable" // no live runtime in the requested mode
  | "loading" // first load in flight
  | "ready" // loaded (possibly empty)
  | "error"; // load failed; retry offered

export type SkillReviewState = {
  status: SkillReviewStatus;
  /** Pending writes awaiting review, oldest first. */
  writes: PendingSkillWrite[];
  /** Current `skills.write_approval` value, undefined until the config loads. */
  gateEnabled?: boolean;
  /** True while the gate toggle is in flight. */
  gatePending: boolean;
  mode?: HermesAdminMode;
  profile?: string;
  /** Ids with an approve/reject in flight. */
  pending: ReadonlySet<string>;
  error?: string;
  retryable: boolean;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  /** Reloads the queue and the gate value. */
  refresh: () => void;
  /** Approves (applies) one staged write, then refreshes. */
  approve: (id: string) => void;
  /** Rejects (discards) one staged write, then refreshes. */
  reject: (id: string) => void;
  /** Approves every readable write in turn. */
  approveAll: () => void;
  /** Rejects every write in turn. */
  rejectAll: () => void;
  /** Sets the write-approval gate. */
  setGate: (enabled: boolean) => void;
  dismissNotification: (id: string) => void;
};

/**
 * The framework-free controller. Holds mutable state for one engine and
 * notifies a single subscriber. Extracted so approve/reject/gate rules are
 * testable without React.
 */
export class SkillReviewController {
  private readonly engine: SkillReviewEngine;
  private writes: PendingSkillWrite[] = [];
  private gateEnabled?: boolean;
  private gatePending = false;
  private status: SkillReviewStatus = "loading";
  private error?: string;
  private retryable = false;
  private readonly pending = new Set<string>();
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: SkillReviewState;

  constructor(engine: SkillReviewEngine) {
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
    // A skills invalidation from any path (a gateway restart's post-refresh, a
    // profile switch, an approved write) reloads the queue so it stays correct.
    this.unsubscribers.push(
      engine.cache.subscribe("skills", () => {
        if (this.engine.cache.isStale("skills")) void this.load();
      }),
    );
  }

  getSnapshot(): SkillReviewState {
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

  /** Loads the pending writes (Rust) and the gate value (config) in parallel. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    if (this.writes.length === 0 && this.gateEnabled === undefined) {
      this.status = "loading";
      this.recompute();
    }

    const [writesResult, gateResult] = await Promise.allSettled([
      this.engine.invoke(PENDING_SKILL_WRITES_COMMAND, {
        mode: this.engine.target.mode,
      }),
      this.engine.client.config.get(),
    ]);
    if (this.disposed || seq !== this.loadSeq) return;

    if (writesResult.status === "fulfilled") {
      this.writes = parsePendingSkillWrites(writesResult.value);
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
    } else {
      const adminError = HermesAdminError.from(
        PENDING_SKILL_WRITES_COMMAND,
        writesResult.reason,
      );
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      this.status = this.writes.length > 0 ? "ready" : "error";
    }

    if (gateResult.status === "fulfilled") {
      this.gateEnabled = readWriteApproval(gateResult.value.config);
    }
    this.recompute();
  }

  /** Approves or rejects one staged write. Optimistically removes the row on
   * success, then refreshes from disk; on failure the row is restored and the
   * safe error surfaced. */
  async resolve(id: string, approve: boolean): Promise<void> {
    if (this.pending.has(id)) return;
    const target = this.writes.find((write) => write.id === id);
    if (!target) return;
    this.pending.add(id);
    this.error = undefined;
    this.recompute();

    try {
      await this.engine.invoke(RESOLVE_PENDING_SKILL_WRITE_COMMAND, {
        request: { id, approve },
      });
      if (this.disposed) return;
      // An approved write changes the skill index, so new sessions must reload;
      // route it through the shared cache so the timing notice + lifecycle banner
      // match every other skill change. A reject changes nothing durable, so it
      // just drains the row with no timing claim.
      if (approve) {
        this.engine.cache.afterMutation("skill.toggle", target.skill);
        this.engine.lifecycle.noteMutation("skill.toggle");
      }
      this.writes = this.writes.filter((write) => write.id !== id);
      this.pending.delete(id);
      this.recompute();
      await this.load();
    } catch (error) {
      if (this.disposed) return;
      this.pending.delete(id);
      const adminError = HermesAdminError.from(
        RESOLVE_PENDING_SKILL_WRITE_COMMAND,
        error,
      );
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  /** Approves every readable write, in order. Unreadable writes are skipped (they
   * cannot be applied) and left in the queue for explicit rejection. */
  async approveAll(): Promise<void> {
    const ids = this.writes
      .filter((write) => write.readable && write.op !== "unknown")
      .map((write) => write.id);
    for (const id of ids) await this.resolve(id, true);
  }

  /** Rejects every write, in order. */
  async rejectAll(): Promise<void> {
    const ids = this.writes.map((write) => write.id);
    for (const id of ids) await this.resolve(id, false);
  }

  /** Sets the `skills.write_approval` gate via the config client. Applies next
   * session; surfaced through the shared cache + lifecycle. */
  async setGate(enabled: boolean): Promise<void> {
    if (this.gatePending || this.gateEnabled === enabled) return;
    this.gatePending = true;
    this.error = undefined;
    const previous = this.gateEnabled;
    this.gateEnabled = enabled; // optimistic
    this.recompute();
    try {
      const outcome = await this.engine.client.config.set(
        WRITE_APPROVAL_PATH,
        enabled ? "true" : "false",
      );
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, "Skill write approval");
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.gatePending = false;
      this.recompute();
    } catch (error) {
      if (this.disposed) return;
      this.gateEnabled = previous; // roll back
      this.gatePending = false;
      const adminError = HermesAdminError.from("PUT /api/config", error);
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  private buildSnapshot(): SkillReviewState {
    return {
      status: this.status,
      writes: this.writes,
      gateEnabled: this.gateEnabled,
      gatePending: this.gatePending,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      pending: new Set(this.pending),
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refreshAction,
      approve: this.approveAction,
      reject: this.rejectAction,
      approveAll: this.approveAllAction,
      rejectAll: this.rejectAllAction,
      setGate: this.setGateAction,
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
  private readonly approveAction = (id: string): void => {
    void this.resolve(id, true);
  };
  private readonly rejectAction = (id: string): void => {
    void this.resolve(id, false);
  };
  private readonly approveAllAction = (): void => {
    void this.approveAll();
  };
  private readonly rejectAllAction = (): void => {
    void this.rejectAll();
  };
  private readonly setGateAction = (enabled: boolean): void => {
    void this.setGate(enabled);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/** Binds a {@link SkillReviewController} to React for one engine. A null engine
 * yields the unavailable state. */
export function useSkillReviewController(
  engine: SkillReviewEngine | null,
): SkillReviewState {
  const controller = useMemo(
    () => (engine ? new SkillReviewController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<SkillReviewState>(() =>
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

const UNAVAILABLE_STATE: SkillReviewState = Object.freeze({
  status: "unavailable",
  writes: [],
  gatePending: false,
  pending: new Set<string>(),
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  refresh: () => {},
  approve: () => {},
  reject: () => {},
  approveAll: () => {},
  rejectAll: () => {},
  setGate: () => {},
  dismissNotification: () => {},
}) as SkillReviewState;

/** Derives the engine from a live bridge status for a mode; null when that mode
 * is not running. Keyed on the target identity so a status poll that does not
 * change the connection keeps the same engine (and its loaded queue). */
export function useSkillReviewEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
  invoke: ReviewInvoke = tauriInvoke as ReviewInvoke,
): SkillReviewEngine | null {
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
    return { target, client, cache, lifecycle, invoke };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity
  }, [identity]);
}

/** The all-in-one production hook the page calls. Tests prefer
 * {@link useSkillReviewController} with a harness engine. */
export function useSkillReview(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): SkillReviewState {
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

  const engine = useSkillReviewEngine(bridge, mode, profile);
  const state = useSkillReviewController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
