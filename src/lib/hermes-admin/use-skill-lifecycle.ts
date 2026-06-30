/**
 * The data hook + framework-free controller behind June's skill lifecycle
 * actions (spec 08): check for updates, update one, update all eligible, audit
 * one, uninstall hub/official, delete local, and reset/restore a bundled skill.
 * It extends the SAME foundation primitives every admin surface shares — the
 * typed {@link HermesAdminClient}, the {@link AdminStateCache} invalidation bus,
 * and the {@link GatewayLifecycle} apply-timing banner — so a lifecycle action
 * behaves identically to a hub install: it backgrounds where Hermes backgrounds,
 * polls to a terminal state, surfaces live progress + safe failure inline, and
 * on success refreshes the installed inventory and toolsets.
 *
 * Source-class safety is enforced in LOGIC, not styling: every action is gated
 * by {@link skillLifecyclePolicy}, so a controller never runs an action that is
 * invalid for a skill's source, and an action that could overwrite local edits
 * is refused unless the caller confirms (the divergence guard). Profile/mode
 * targeting is explicit: the controller is built from ONE target's engine, so an
 * action can only ever hit the runtime that target names.
 *
 * Two actions are NOT plain REST:
 * - audit calls `skills.hubScan` (a read-only `GET /api/skills/hub/scan`);
 * - reset/restore has no REST endpoint, so it runs the narrow, version-gated
 *   Tauri CLI fallback ({@link hermesResetBundledSkill}) with an argument-safe
 *   skill name. The controller refuses a reset whose name is not slug-safe
 *   BEFORE invoking it, mirroring the Rust validator.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  hermesBridgeStatus,
  hermesResetBundledSkill,
  type HermesBridgeStatus,
} from "../tauri";
import { AdminStateCache } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import { GatewayLifecycle } from "./gateway-lifecycle";
import { createRustAdminFetch } from "./rust-transport";
import type {
  HermesActionStatus,
  HermesSkillInfo,
  HermesSkillScan,
} from "./schemas";
import {
  hubIdentifierOf,
  isSafeSkillName,
  skillLifecyclePolicy,
  type SkillLifecycleAction,
  type SkillLifecyclePolicy,
} from "./skill-lifecycle-view";
import { adminTargetForMode, type HermesAdminMode } from "./target";
import type { HermesAdminTarget } from "./target";

/** The wired foundation primitives a lifecycle controller operates on, all bound
 * to the SAME target. Identical shape to the installed-skills engine, reused so
 * the controller can sit beside the inventory and share its cache. */
export type SkillLifecycleEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

/** Phase of one in-flight lifecycle action. `idle` is the default; `running`
 * carries optional progress; `done` / `failed` are terminal until cleared. */
export type LifecyclePhase = "idle" | "running" | "done" | "failed";

/** The live state of one lifecycle action against one skill. */
export type SkillLifecycleActionState = {
  skill: string;
  action: SkillLifecycleAction;
  phase: LifecyclePhase;
  /** 0-100 progress while running, when Hermes reports it. */
  progress?: number;
  /** A safe status/log message from the action, when present. */
  message?: string;
  /** A safe error message when `phase === "failed"`. */
  error?: string;
  /** The audit scan result, when this was an audit that completed. */
  scan?: HermesSkillScan;
};

/** Options passed when running an action that may overwrite local edits. */
export type RunActionOptions = {
  /** When the policy flags a divergence (local edits), the action is refused
   * unless this is true. The UI sets it after the user confirms the overwrite,
   * so local edits are never silently clobbered. */
  acceptDivergence?: boolean;
};

/** Test-only knobs for the poll loop, so suites drive a backgrounded action
 * without real timers. */
export type SkillLifecycleControllerOptions = {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable reset bridge so a test asserts the CLI fallback without Tauri.
   * Defaults to the real {@link hermesResetBundledSkill}. */
  resetBundled?: typeof hermesResetBundledSkill;
  /** Called after any action that mutates the inventory completes successfully
   * (update / uninstall / delete / reset / restore / audit). The host wires this
   * to the installed-skills page's `refresh` so the inventory + toolsets reload
   * when a lifecycle action finishes, even though the two surfaces hold separate
   * cache instances. Never called for a failed action. */
  onMutated?: () => void;
};

/** A key uniquely identifying one action against one skill. */
function actionKey(skill: string, action: SkillLifecycleAction): string {
  return `${skill}::${action}`;
}

/** Everything a lifecycle surface renders, plus the actions it invokes. A pure
 * projection of the controller's state. */
export type SkillLifecycleState = {
  /** The mode + profile the actions target, so blast radius is explicit. */
  mode: HermesAdminMode;
  profile: string;
  /** Per-(skill,action) in-flight state, for progress + inline failure. */
  actions: ReadonlyMap<string, SkillLifecycleActionState>;
  /** True while a check-for-updates / update-all sweep is in flight. */
  sweeping: boolean;
  /** A safe error from the last sweep, when one failed. */
  sweepError?: string;
  /** The lifecycle policy for a skill (which actions are valid + why not). */
  policyFor: (skill: HermesSkillInfo) => SkillLifecyclePolicy;
  /** Runs a lifecycle action against a skill. A no-op when the action is invalid
   * for the skill's source, or when it would overwrite local edits and the
   * divergence was not accepted. */
  run: (
    skill: HermesSkillInfo,
    action: SkillLifecycleAction,
    options?: RunActionOptions,
  ) => void;
  /** Re-checks all installed hub/official skills against the hub for updates by
   * refreshing the inventory + hub search. */
  checkForUpdates: () => void;
  /** Updates every eligible (hub/official, update-available, not locally
   * modified) skill in the current inventory. */
  updateAll: (skills: readonly HermesSkillInfo[]) => void;
  /** Clears a terminal action state so the row returns to its default. */
  clearAction: (skill: string, action: SkillLifecycleAction) => void;
};

/**
 * The framework-free controller. Holds the mutable per-action state for one
 * engine and notifies a single subscriber (the hook) on change. Extracted so the
 * run/poll/refresh/source-gating rules are unit-testable without React.
 */
export class SkillLifecycleController {
  private readonly engine: SkillLifecycleEngine;
  private readonly options: SkillLifecycleControllerOptions;
  private readonly resetBundled: typeof hermesResetBundledSkill;
  private onMutated?: () => void;
  private readonly actions = new Map<string, SkillLifecycleActionState>();
  private sweeping = false;
  private sweepError?: string;
  private listeners = new Set<() => void>();
  private disposed = false;
  private readonly aborts = new Map<string, AbortController>();
  private snapshot: SkillLifecycleState;

  constructor(
    engine: SkillLifecycleEngine,
    options: SkillLifecycleControllerOptions = {},
  ) {
    this.engine = engine;
    this.options = options;
    this.resetBundled = options.resetBundled ?? hermesResetBundledSkill;
    this.onMutated = options.onMutated;
    this.snapshot = this.buildSnapshot();
  }

  getSnapshot(): SkillLifecycleState {
    return this.snapshot;
  }

  /** Updates the post-mutation refresh callback without rebuilding the
   * controller, so a host can keep its `refresh` closure current. */
  setOnMutated(onMutated?: () => void): void {
    this.onMutated = onMutated;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.aborts.values()) controller.abort();
    this.aborts.clear();
    this.listeners.clear();
  }

  /** The lifecycle policy for a skill. */
  policyFor(skill: HermesSkillInfo): SkillLifecyclePolicy {
    return skillLifecyclePolicy(skill);
  }

  /**
   * Runs a lifecycle action against a skill. Source-class gated: the policy must
   * mark the action available, or this is a no-op (the row's disabled state
   * already explains why). When the action carries a divergence warning (local
   * edits would be overwritten), it is refused unless `acceptDivergence` is set,
   * so local edits are never silently clobbered. Never throws.
   */
  async run(
    skill: HermesSkillInfo,
    action: SkillLifecycleAction,
    options: RunActionOptions = {},
  ): Promise<void> {
    if (this.disposed) return;
    const key = actionKey(skill.name, action);
    if (this.actions.get(key)?.phase === "running") return;

    const policy = skillLifecyclePolicy(skill);
    const availability = policy.actions[action];
    if (!availability.available) return;
    if (availability.divergenceWarning && !options.acceptDivergence) {
      // Refuse rather than overwrite: the UI must surface the divergence and
      // re-run with acceptDivergence once the user confirms.
      this.setAction(skill.name, action, {
        phase: "failed",
        error: availability.divergenceWarning,
      });
      return;
    }

    switch (action) {
      case "update":
        return this.runHubAction(skill, policy, "update");
      case "uninstall":
      case "delete":
        return this.runHubAction(skill, policy, "uninstall");
      case "audit":
        return this.runAudit(skill, policy);
      case "reset":
        return this.runReset(skill, false);
      case "restore":
        return this.runReset(skill, true);
      case "check":
        return this.runCheck(skill, policy);
    }
  }

  /** Re-checks all installed skills for updates by refreshing the inventory and
   * hub search through the cache invalidation bus. The inventory page's own
   * subscription reloads the list; here we just mark the resources stale and
   * surface the sweep state. */
  async checkForUpdates(): Promise<void> {
    if (this.disposed || this.sweeping) return;
    this.sweeping = true;
    this.sweepError = undefined;
    this.recompute();
    try {
      // A check is a re-read. Mark this controller's resources stale, then ask
      // the host to refresh the inventory. The installed-skills controller has
      // its OWN AdminStateCache instance, so invalidating ours never reaches its
      // subscribers; `onMutated` (the host's inventory refresh, the same one
      // runHubAction fires) is what actually re-reads GET /api/skills so the
      // update_available flags refresh.
      this.engine.cache.invalidate(["skills", "hubSearch"]);
      this.onMutated?.();
      if (this.disposed) return;
      this.sweeping = false;
      this.recompute();
    } catch (error) {
      if (this.disposed) return;
      this.sweeping = false;
      this.sweepError = HermesAdminError.from(
        "GET /api/skills",
        error,
      ).safeMessage;
      this.recompute();
    }
  }

  /** Updates every eligible skill in the list: hub/official, an update is
   * available, and NOT locally modified (we never overwrite local edits in a
   * bulk sweep — those are updated one at a time with an explicit confirm). */
  async updateAll(skills: readonly HermesSkillInfo[]): Promise<void> {
    if (this.disposed || this.sweeping) return;
    const eligible = skills.filter((skill) => {
      const policy = skillLifecyclePolicy(skill);
      return (
        policy.actions.update.available &&
        policy.updateAvailable &&
        !policy.locallyModified
      );
    });
    if (eligible.length === 0) return;
    this.sweeping = true;
    this.sweepError = undefined;
    this.recompute();
    try {
      // Run them sequentially so progress is legible and the server is not
      // hammered; each is its own background action with its own row state.
      for (const skill of eligible) {
        if (this.disposed) return;
        await this.runHubAction(skill, skillLifecyclePolicy(skill), "update");
      }
    } finally {
      if (!this.disposed) {
        this.sweeping = false;
        this.recompute();
      }
    }
  }

  clearAction(skill: string, action: SkillLifecycleAction): void {
    if (this.actions.delete(actionKey(skill, action))) this.recompute();
  }

  // --- action runners ------------------------------------------------------

  /** Runs a backgrounded hub update/uninstall: calls the client, polls the
   * returned action to a terminal state with live progress, then on success
   * applies the cache invalidation + durable notification + lifecycle banner so
   * the inventory + toolsets refresh. Mirrors the hub install controller. */
  private async runHubAction(
    skill: HermesSkillInfo,
    policy: SkillLifecyclePolicy,
    kind: "update" | "uninstall",
  ): Promise<void> {
    // The row action key uses the requested action verb (update / uninstall /
    // delete) so the UI can target the exact button; a local skill's removal is
    // surfaced as "delete", a hub skill's as "uninstall".
    const rowAction: SkillLifecycleAction =
      kind === "update"
        ? "update"
        : policy.lifecycleClass === "local"
          ? "delete"
          : "uninstall";
    this.setAction(skill.name, rowAction, {
      phase: "running",
      progress: undefined,
    });

    try {
      const outcome =
        kind === "update"
          ? await this.engine.client.skills.hubUpdate(skill.name)
          : await this.engine.client.skills.hubUninstall(
              hubIdentifierOf(skill) ?? skill.name,
            );
      if (this.disposed) return;

      let status: HermesActionStatus | undefined = outcome.result;
      const handle = outcome.action;
      if (handle && !(status?.done ?? false)) {
        const abort = new AbortController();
        const key = actionKey(skill.name, rowAction);
        this.aborts.set(key, abort);
        try {
          status = await this.engine.client.pollAction(handle, {
            signal: abort.signal,
            intervalMs: this.options.pollIntervalMs,
            timeoutMs: this.options.pollTimeoutMs,
            sleep: this.options.sleep,
            onStatus: (latest) =>
              this.setAction(skill.name, rowAction, {
                phase: "running",
                progress: latest.progress,
                message: latest.message,
              }),
          });
        } finally {
          this.aborts.delete(key);
        }
        if (this.disposed) return;
      }

      if (status && status.state === "failed") {
        const mutation =
          kind === "update" ? "skill.hubUpdate" : "skill.hubUninstall";
        this.engine.cache.afterAction(mutation, skill.name, status);
        this.setAction(skill.name, rowAction, {
          phase: "failed",
          error: status.error ?? `Could not ${kind} ${skill.name}.`,
        });
        return;
      }

      const mutation =
        kind === "update" ? "skill.hubUpdate" : "skill.hubUninstall";
      this.engine.cache.afterMutation(mutation, skill.name);
      this.engine.lifecycle.noteMutation(mutation);
      this.setAction(skill.name, rowAction, {
        phase: "done",
        progress: 100,
        message: status?.message,
      });
      this.onMutated?.();
    } catch (error) {
      if (this.disposed) return;
      const endpoint =
        kind === "update"
          ? "POST /api/skills/hub/update"
          : "POST /api/skills/hub/uninstall";
      this.setAction(skill.name, rowAction, {
        phase: "failed",
        error: HermesAdminError.from(endpoint, error).safeMessage,
      });
    }
  }

  /** Runs a read-only audit: `skills.hubScan`. It mutates nothing, so it raises
   * no durable notification beyond the immediate result; it surfaces the scan
   * inline on the row. */
  private async runAudit(
    skill: HermesSkillInfo,
    policy: SkillLifecyclePolicy,
  ): Promise<void> {
    this.setAction(skill.name, "audit", { phase: "running" });
    try {
      const scan = await this.engine.client.skills.hubScan(
        policy.hubIdentifier ?? skill.name,
      );
      if (this.disposed) return;
      // An audit changes nothing durable; record the result and raise the
      // "audited" notification through the cache (which also invalidates the
      // hub search whose verdict the row may reflect).
      this.engine.cache.afterMutation("skill.audit", skill.name);
      this.setAction(skill.name, "audit", {
        phase: "done",
        scan,
        message: scan.summary,
      });
    } catch (error) {
      if (this.disposed) return;
      this.setAction(skill.name, "audit", {
        phase: "failed",
        error: HermesAdminError.from("GET /api/skills/hub/scan", error)
          .safeMessage,
      });
    }
  }

  /** Runs the bundled-skill reset/restore CLI fallback. The skill name is
   * validated argument-safe BEFORE the Tauri call (the Rust side re-validates),
   * so a name that could escape into a flag never leaves the webview. */
  private async runReset(
    skill: HermesSkillInfo,
    restore: boolean,
  ): Promise<void> {
    const rowAction: SkillLifecycleAction = restore ? "restore" : "reset";
    if (!isSafeSkillName(skill.name)) {
      this.setAction(skill.name, rowAction, {
        phase: "failed",
        error:
          "This skill's name cannot be reset safely from June. Reset it in Hermes.",
      });
      return;
    }
    this.setAction(skill.name, rowAction, { phase: "running" });
    try {
      const result = await this.resetBundled({
        mode: this.engine.target.mode,
        name: skill.name,
        profile: this.engine.target.profile,
        restore,
      });
      if (this.disposed) return;
      if (!result.ok) {
        this.setAction(skill.name, rowAction, {
          phase: "failed",
          error:
            result.message ??
            (result.timedOut
              ? "The reset is still running in Hermes. Refresh to see the result."
              : `Could not reset ${skill.name}.`),
        });
        return;
      }
      // A successful reset rewrote the manifest: invalidate the inventory +
      // toolsets and raise the next-session notification + banner.
      this.engine.cache.afterMutation("skill.reset", skill.name);
      this.engine.lifecycle.noteMutation("skill.reset");
      this.setAction(skill.name, rowAction, {
        phase: "done",
        message: result.message ?? undefined,
      });
      this.onMutated?.();
    } catch (error) {
      if (this.disposed) return;
      this.setAction(skill.name, rowAction, {
        phase: "failed",
        error:
          error instanceof Error
            ? error.message
            : `Could not reset ${skill.name}.`,
      });
    }
  }

  /** A "check for updates" on a single skill: re-audit it so its verdict and any
   * available-update signal refresh, plus invalidate the inventory + hub search.
   * For a hub/official skill this is its audit; the row reflects the outcome. */
  private async runCheck(
    skill: HermesSkillInfo,
    policy: SkillLifecyclePolicy,
  ): Promise<void> {
    this.engine.cache.invalidate(["skills", "hubSearch"]);
    await this.runAudit(skill, policy);
  }

  // --- internals -----------------------------------------------------------

  private setAction(
    skill: string,
    action: SkillLifecycleAction,
    next: Omit<SkillLifecycleActionState, "skill" | "action">,
  ): void {
    this.actions.set(actionKey(skill, action), { skill, action, ...next });
    this.recompute();
  }

  private buildSnapshot(): SkillLifecycleState {
    return {
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      actions: new Map(this.actions),
      sweeping: this.sweeping,
      sweepError: this.sweepError,
      policyFor: this.policyForAction,
      run: this.runAction,
      checkForUpdates: this.checkForUpdatesAction,
      updateAll: this.updateAllAction,
      clearAction: this.clearActionAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private readonly policyForAction = (
    skill: HermesSkillInfo,
  ): SkillLifecyclePolicy => skillLifecyclePolicy(skill);
  private readonly runAction = (
    skill: HermesSkillInfo,
    action: SkillLifecycleAction,
    options?: RunActionOptions,
  ): void => {
    void this.run(skill, action, options);
  };
  private readonly checkForUpdatesAction = (): void => {
    void this.checkForUpdates();
  };
  private readonly updateAllAction = (
    skills: readonly HermesSkillInfo[],
  ): void => {
    void this.updateAll(skills);
  };
  private readonly clearActionAction = (
    skill: string,
    action: SkillLifecycleAction,
  ): void => {
    this.clearAction(skill, action);
  };
}

/** Binds a {@link SkillLifecycleController} to React for one engine. A null
 * engine yields the unavailable (no-op) state without constructing a controller. */
export function useSkillLifecycleController(
  engine: SkillLifecycleEngine | null,
  options: Pick<SkillLifecycleControllerOptions, "onMutated"> = {},
): SkillLifecycleState {
  const { onMutated } = options;
  const controller = useMemo(
    () => (engine ? new SkillLifecycleController(engine, { onMutated }) : null),
    // onMutated is intentionally excluded: a stable host callback should not
    // rebuild the controller (which would drop in-flight action state). The
    // controller reads the latest via the ref below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine],
  );

  const [snapshot, setSnapshot] = useState<SkillLifecycleState>(() =>
    controller ? controller.getSnapshot() : unavailableState(),
  );

  // Keep the host's refresh callback current on the controller without
  // rebuilding it.
  useEffect(() => {
    controller?.setOnMutated(onMutated);
  }, [controller, onMutated]);

  useEffect(() => {
    if (!controller) {
      setSnapshot(unavailableState());
      return;
    }
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(() => {
      setSnapshot(controller.getSnapshot());
    });
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return snapshot;
}

/** The no-op state when there is no runtime to target. */
function unavailableState(): SkillLifecycleState {
  return {
    mode: "sandboxed",
    profile: "default",
    actions: new Map(),
    sweeping: false,
    policyFor: (skill) => skillLifecyclePolicy(skill),
    run: () => {},
    checkForUpdates: () => {},
    updateAll: () => {},
    clearAction: () => {},
  };
}

/**
 * Production helper: derives the {@link SkillLifecycleEngine} for a chosen mode
 * from a live bridge status, returning null when that mode is not running.
 * Profile targeting is explicit via {@link adminTargetForMode}; the admin I/O is
 * routed through Rust (`hermes_admin_request`) like every other surface.
 */
export function useSkillLifecycleEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): SkillLifecycleEngine | null {
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

/**
 * The all-in-one production hook: fetch bridge status once, derive the engine for
 * the mode, and run the lifecycle controller. The installed-skills / detail
 * surfaces call THIS; tests prefer {@link useSkillLifecycleController} with a
 * harness engine so they need no Tauri mock.
 *
 * IMPORTANT: this builds its OWN engine (cache + lifecycle), distinct from the
 * inventory page's. The two stay coherent through the standing cache
 * invalidation rules — a lifecycle action marks `skills` stale, and the
 * inventory controller reloads off its own bus — so the page refreshes after a
 * lifecycle action completes without the two controllers sharing one cache
 * instance.
 */
export function useSkillLifecycle(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
  onMutated?: () => void,
): SkillLifecycleState {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();
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
      .catch(() => {
        // A bridge failure leaves bridge undefined -> null engine -> the no-op
        // state, which is the right "Hermes not running" surface.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useSkillLifecycleEngine(bridge, mode, profile);
  return useSkillLifecycleController(engine, { onMutated });
}
