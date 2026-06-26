/**
 * Shared Hermes gateway restart/reindex lifecycle (spec 21). A large class of
 * perceived bugs comes from changing a setting and expecting the live agent to
 * know instantly; June makes lifecycle semantics first-class so every Skills/MCP
 * change marks its restart/new-session requirement the SAME way and any page can
 * drive (or link to) one restart flow.
 *
 * This module owns:
 * - the {@link GatewayLifecycleState} machine and its display copy;
 * - a restart DRIVER that calls the gateway endpoint, polls the backgrounded
 *   action to completion, and invalidates MCP servers / toolsets / skills /
 *   gateway status afterward (via the cache layer);
 * - an active-session guard: restart is never automatic — the caller confirms
 *   when a live session would be interrupted.
 *
 * It does not render. A component subscribes to a {@link GatewayLifecycle}
 * instance and calls `requestRestart`. Copy is sentence case, no dashes.
 */

import { timingForMutation, type AdminMutation } from "./application-timing";
import { AdminStateCache, type AdminResource } from "./cache";
import type { HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import type { HermesActionStatus } from "./schemas";

/** The lifecycle states a page can be in with respect to pending admin changes
 * and the gateway. Mirrors spec 21's enumerated states. */
export type GatewayLifecycleState =
  | "clean"
  | "changes-apply-next-session"
  | "gateway-restart-required"
  | "restart-in-progress"
  | "restart-failed"
  | "reindex-in-progress"
  | "live-session-unaffected"
  | "active-session-should-restart";

/** A snapshot a subscriber renders. */
export type GatewayLifecycleSnapshot = {
  state: GatewayLifecycleState;
  /** Headline copy for the current state. */
  label: string;
  /** Longer explanatory copy. */
  detail: string;
  /** 0-100 progress while a restart action is running, when known. */
  progress?: number;
  /** Safe error message when `state === "restart-failed"`. */
  error?: string;
  /** Whether a restart button should be offered. */
  canRestart: boolean;
};

/** Copy for each state. Sentence case, no em/en-dashes. */
function describe(
  state: GatewayLifecycleState,
): Pick<GatewayLifecycleSnapshot, "label" | "detail" | "canRestart"> {
  switch (state) {
    case "clean":
      return {
        label: "Up to date",
        detail: "No pending changes.",
        canRestart: false,
      };
    case "changes-apply-next-session":
      return {
        label: "Applies next session",
        detail:
          "Your changes take effect in new sessions. Current sessions are unaffected.",
        canRestart: false,
      };
    case "gateway-restart-required":
      return {
        label: "Restart required",
        detail: "Restart the Hermes gateway to apply your changes.",
        canRestart: true,
      };
    case "restart-in-progress":
      return {
        label: "Restarting gateway",
        detail: "Applying your changes. This can take a moment.",
        canRestart: false,
      };
    case "restart-failed":
      return {
        label: "Restart failed",
        detail: "The gateway did not restart. You can try again.",
        canRestart: true,
      };
    case "reindex-in-progress":
      return {
        label: "Refreshing",
        detail: "Rebuilding the tool and skill inventory.",
        canRestart: false,
      };
    case "live-session-unaffected":
      return {
        label: "Live session unaffected",
        detail: "This change does not interrupt the running session.",
        canRestart: false,
      };
    case "active-session-should-restart":
      return {
        label: "Restart the session to apply",
        detail:
          "A session is running. Restart it for this change to take effect.",
        canRestart: true,
      };
  }
}

export type RequestRestartOptions = {
  /** True when at least one session is actively running. The driver refuses to
   * restart unless `confirmInterrupt` resolves true, so a live session is never
   * silently disrupted. */
  hasActiveSession?: boolean;
  /** Asked before interrupting an active session. Return true to proceed. When
   * omitted and `hasActiveSession` is true, the restart is declined. */
  confirmInterrupt?: () => boolean | Promise<boolean>;
  /** Poll interval for the restart action, forwarded to `pollAction`. */
  pollIntervalMs?: number;
  /** Overall timeout for the restart action. */
  pollTimeoutMs?: number;
  /** Injectable sleep for the poll loop (tests). */
  sleep?: (ms: number) => Promise<void>;
};

/** What a `requestRestart` call resolves to. */
export type RestartOutcome = {
  ok: boolean;
  /** Why a restart did not run: the user declined the active-session prompt. */
  declined?: boolean;
  /** The terminal action status, when a backgrounded restart ran. */
  status?: HermesActionStatus;
  /** Resources invalidated after a successful restart. */
  invalidated?: readonly AdminResource[];
  error?: HermesAdminError;
};

/**
 * Drives the gateway restart/reindex lifecycle for one target's admin client and
 * cache. Subscribe for state; call {@link requestRestart} to perform a restart;
 * call {@link markRestartRequired} / {@link markNextSession} from page mutations
 * to advance the banner consistently.
 */
export class GatewayLifecycle {
  private readonly client: HermesAdminClient;
  private readonly cache: AdminStateCache;
  private snapshot: GatewayLifecycleSnapshot;
  private readonly subscribers = new Set<
    (snapshot: GatewayLifecycleSnapshot) => void
  >();

  constructor(client: HermesAdminClient, cache: AdminStateCache) {
    this.client = client;
    this.cache = cache;
    this.snapshot = this.snapshotFor("clean");
  }

  /** The current snapshot. */
  getSnapshot(): GatewayLifecycleSnapshot {
    return this.snapshot;
  }

  /** Subscribes to lifecycle changes. Fires immediately with the current
   * snapshot, then on every transition. Returns an unsubscribe. */
  subscribe(
    listener: (snapshot: GatewayLifecycleSnapshot) => void,
  ): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Advances the banner for a mutation that just succeeded, by its application
   * timing: a restart-required mutation sets `gateway-restart-required`; a
   * next-session one sets `changes-apply-next-session` (unless a stronger state
   * is already showing). Pages call this after a successful client mutation so
   * the banner is consistent across Skills and MCP. */
  noteMutation(mutation: AdminMutation): void {
    const timing = timingForMutation(mutation);
    if (timing === "gateway-restart") {
      this.markRestartRequired();
    } else if (timing === "next-session") {
      // Do not downgrade a pending restart to a next-session note.
      if (this.snapshot.state !== "gateway-restart-required") {
        this.transition("changes-apply-next-session");
      }
    }
    // immediate mutations leave the banner where it is.
  }

  /** Forces the restart-required state (e.g. after an MCP change). */
  markRestartRequired(): void {
    this.transition("gateway-restart-required");
  }

  /** Sets the next-session state, if nothing stronger is pending. */
  markNextSession(): void {
    if (this.snapshot.state !== "gateway-restart-required") {
      this.transition("changes-apply-next-session");
    }
  }

  /** Flags that a change needs the ACTIVE session restarted to apply. */
  markActiveSessionShouldRestart(): void {
    this.transition("active-session-should-restart");
  }

  /** States that the change just made does NOT disturb the running session
   * (e.g. an `immediate` mutation, or one that only affects new sessions while a
   * session is live). The reassuring counterpart to
   * {@link markActiveSessionShouldRestart}; pages call it after a change that is
   * safe for the current session so the banner says so explicitly. */
  markLiveSessionUnaffected(): void {
    this.transition("live-session-unaffected");
  }

  /** Resets to clean (e.g. after the page reloaded fresh data). */
  reset(): void {
    this.transition("clean");
  }

  /**
   * Performs a gateway restart: guards an active session, calls the restart
   * endpoint, polls the backgrounded action, and on success invalidates and
   * refreshes the post-restart resources. Never throws — failures resolve as
   * `{ ok: false, error }` and leave the banner in `restart-failed`.
   */
  async requestRestart(
    options: RequestRestartOptions = {},
  ): Promise<RestartOutcome> {
    // Never interrupt a live session without explicit confirmation.
    if (options.hasActiveSession) {
      const proceed = options.confirmInterrupt
        ? await options.confirmInterrupt()
        : false;
      if (!proceed) {
        return { ok: false, declined: true };
      }
    }

    this.transition("restart-in-progress");
    try {
      const outcome = await this.client.gateway.restart();
      const action = outcome.action;

      let status: HermesActionStatus | undefined;
      if (action) {
        status = await this.client.pollAction(action, {
          intervalMs: options.pollIntervalMs,
          timeoutMs: options.pollTimeoutMs,
          sleep: options.sleep,
          onStatus: (latest) => this.applyProgress(latest),
        });
        if (status.state === "failed") {
          this.transition("restart-failed", {
            error: status.error ?? "The gateway restart failed.",
          });
          return { ok: false, status };
        }
      }

      // Post-restart: rebuild the inventory, then refresh from the live runtime.
      this.transition("reindex-in-progress");
      const invalidated = await this.refreshAfterRestart();
      this.transition("clean");
      return { ok: true, status, invalidated };
    } catch (error) {
      const adminError = HermesAdminError.from(
        "POST /api/gateway/restart",
        error,
      );
      this.transition("restart-failed", { error: adminError.safeMessage });
      return { ok: false, error: adminError };
    }
  }

  /**
   * Invalidates and reloads the resources that change across a gateway restart:
   * MCP servers, toolsets, skills, and gateway status. Returns the invalidated
   * resource list. A refetch that fails leaves the resource stale (the next
   * read retries) rather than throwing out of the restart flow.
   */
  private async refreshAfterRestart(): Promise<readonly AdminResource[]> {
    const resources: AdminResource[] = [
      "mcpServers",
      "toolsets",
      "skills",
      "gatewayStatus",
    ];
    this.cache.invalidate(resources);

    // Best-effort eager reload so subscribers see fresh data immediately. Each
    // is independent; a failure is swallowed (the entry stays stale).
    await Promise.allSettled([
      this.reload("mcpServers", () => this.client.mcp.listServers()),
      this.reload("toolsets", () => this.client.toolsets.list()),
      this.reload("skills", () => this.client.skills.list()),
      this.reload("gatewayStatus", () => this.client.gateway.status()),
    ]);
    return resources;
  }

  private async reload(
    resource: AdminResource,
    load: () => Promise<unknown>,
  ): Promise<void> {
    try {
      this.cache.set(resource, await load());
    } catch {
      // Leave stale; the next consumer read will retry.
    }
  }

  private applyProgress(status: HermesActionStatus): void {
    this.snapshot = { ...this.snapshot, progress: status.progress };
    this.emit();
  }

  private snapshotFor(
    state: GatewayLifecycleState,
    extra?: { error?: string },
  ): GatewayLifecycleSnapshot {
    return {
      state,
      ...describe(state),
      error: extra?.error,
      progress: undefined,
    };
  }

  private transition(
    state: GatewayLifecycleState,
    extra?: { error?: string },
  ): void {
    this.snapshot = this.snapshotFor(state, extra);
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.subscribers]) listener(this.snapshot);
  }
}
