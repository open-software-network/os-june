/**
 * The shared admin-state cache and refresh lifecycle (spec 02). Skills, MCP,
 * Toolsets, gateway status, and background actions all change through many
 * paths (June UI, the upstream dashboard, slash/CLI commands, background
 * installs, profile switches), so every admin page must invalidate and refresh
 * by the SAME rules or it will show stale enabled-states and wrong "applied"
 * claims.
 *
 * This is a small dedicated cache (the app has no React Query) with three jobs:
 * - keyed, profile-scoped resources (the target's mode+profile is part of every
 *   key, so a profile switch cannot surface the previous profile's data);
 * - a declarative map from each mutation to the resources it invalidates, plus
 *   the application timing to surface (reused from `./application-timing`);
 * - a durable notification channel for "skill enabled / restart required /
 *   gateway restarted" messages, separate from transient toasts.
 *
 * It is deliberately framework-agnostic (subscribe/get/invalidate). A thin React
 * hook can sit on top later; the rules live here so they are unit-testable
 * without rendering.
 */

import {
  mutationNotification,
  timingForMutation,
  type AdminMutation,
  type ApplicationTiming,
} from "./application-timing";
import type { HermesActionStatus } from "./schemas";
import { targetKey, type HermesAdminTarget } from "./target";

/** The cacheable admin resources. The string values are the stable key prefixes
 * (each gets the target key appended). */
export type AdminResource =
  | "skills"
  | "hubSearch"
  | "toolsets"
  | "mcpServers"
  | "mcpCatalog"
  | "profiles"
  | "gatewayStatus"
  | "actionStatus"
  | "envConfig"
  | "configTree";

/** The resources each mutation invalidates. These encode the spec's rules:
 * - skill toggle / hub install-update-uninstall: skills (+ hub + toolsets for
 *   hub ops, since a new skill can register tools);
 * - skill content edit (SKILL.md rewrite): skills (the metadata/description a
 *   row shows is read from SKILL.md frontmatter, so a rewrite can change it);
 * - MCP add/remove/test/enable/filter: mcpServers AND toolsets;
 * - catalog install: mcpServers, catalog, toolsets;
 * - env writes: envConfig (+ gatewayStatus, since a restart may be needed);
 * - skill config writes: configTree (+ skills, since a skill's setup status can
 *   change once its config is filled in);
 * - gateway restart: mcpServers, toolsets, skills, gatewayStatus (full refresh).
 */
const INVALIDATION: Readonly<Record<AdminMutation, readonly AdminResource[]>> =
  Object.freeze({
    "skill.toggle": ["skills"],
    "skill.editContent": ["skills"],
    "skill.hubInstall": ["skills", "hubSearch", "toolsets"],
    "skill.hubUpdate": ["skills", "hubSearch", "toolsets"],
    "skill.hubUninstall": ["skills", "hubSearch", "toolsets"],
    // An audit changes nothing durable, so it invalidates only the hub search
    // (whose scan/verdict the row may reflect), not the installed inventory.
    "skill.audit": ["hubSearch"],
    // Resetting a bundled skill rewrites its manifest, so the inventory (and any
    // tools it registers) must refresh, exactly like a hub update.
    "skill.reset": ["skills", "toolsets"],
    "toolset.toggle": ["toolsets"],
    "mcp.add": ["mcpServers", "toolsets"],
    "mcp.remove": ["mcpServers", "toolsets"],
    "mcp.setEnabled": ["mcpServers", "toolsets"],
    // A tool-filter write changes config.yaml; the server list reflects the new
    // include/exclude policy and the toolset inventory it feeds, so both refresh.
    "mcp.setTools": ["mcpServers", "toolsets", "configTree"],
    "mcp.test": ["mcpServers", "toolsets"],
    "mcp.oauthLogin": ["mcpServers", "toolsets"],
    "mcp.installCatalog": ["mcpServers", "mcpCatalog", "toolsets"],
    "env.set": ["envConfig", "gatewayStatus"],
    "env.delete": ["envConfig", "gatewayStatus"],
    "config.set": ["configTree", "skills"],
    "config.delete": ["configTree", "skills"],
    // Creating a profile (and writing its SOUL) changes the profile roster; it
    // does not touch the active runtime's skills/toolsets, so only `profiles`
    // is invalidated.
    "profile.create": ["profiles"],
    "profile.setSoul": ["profiles"],
    "gateway.restart": ["mcpServers", "toolsets", "skills", "gatewayStatus"],
  });

/** The resources a mutation invalidates. Exported so the lifecycle layer and
 * tests can assert the rule without reaching into the cache. */
export function resourcesForMutation(
  mutation: AdminMutation,
): readonly AdminResource[] {
  return INVALIDATION[mutation];
}

/** A durable admin notification (not a transient toast). `timing` lets the UI
 * style restart-required distinctly from next-session. */
export type AdminNotification = {
  id: string;
  message: string;
  timing: ApplicationTiming;
  mutation: AdminMutation;
  /** Epoch ms when raised. */
  at: number;
  /** True when this notification reports a failure (e.g. a background action
   * that failed), so the UI can render it as an error inline. */
  isError?: boolean;
};

type ResourceKey = `${AdminResource}::${string}`;

type CacheEntry = {
  /** Monotonic version, bumped on every invalidate; lets subscribers refetch. */
  version: number;
  /** Last successfully loaded value, if any. */
  value?: unknown;
  /** Whether the entry is stale (invalidated since last load). */
  stale: boolean;
};

/**
 * A profile-scoped admin cache for ONE target. The target's mode+profile is
 * baked into every key, so two caches for two targets never collide and a
 * profile switch (a new target) starts from a clean key space.
 */
export class AdminStateCache {
  private readonly target: HermesAdminTarget;
  private readonly entries = new Map<ResourceKey, CacheEntry>();
  private readonly resourceSubscribers = new Map<
    ResourceKey,
    Set<() => void>
  >();
  private readonly notifications: AdminNotification[] = [];
  private readonly notificationSubscribers = new Set<
    (notifications: readonly AdminNotification[]) => void
  >();
  private notificationSeq = 0;

  constructor(target: HermesAdminTarget) {
    this.target = target;
  }

  /** The key for a resource under this cache's target. */
  keyFor(resource: AdminResource): ResourceKey {
    return `${resource}::${targetKey(this.target)}`;
  }

  /** Reads the cached value for a resource, or undefined if never loaded. */
  get<T>(resource: AdminResource): T | undefined {
    return this.entries.get(this.keyFor(resource))?.value as T | undefined;
  }

  /** Whether a resource is stale (invalidated and not reloaded since). A
   * never-loaded resource is stale. */
  isStale(resource: AdminResource): boolean {
    const entry = this.entries.get(this.keyFor(resource));
    return entry ? entry.stale : true;
  }

  /** The current version of a resource; changes on invalidate and on set. */
  versionOf(resource: AdminResource): number {
    return this.entries.get(this.keyFor(resource))?.version ?? 0;
  }

  /** Stores a freshly loaded value and clears its stale flag. Notifies the
   * resource's subscribers. */
  set<T>(resource: AdminResource, value: T): void {
    const key = this.keyFor(resource);
    const previous = this.entries.get(key);
    this.entries.set(key, {
      version: (previous?.version ?? 0) + 1,
      value,
      stale: false,
    });
    this.notifyResource(key);
  }

  /** Marks resources stale and bumps their versions so subscribers refetch.
   * Used directly for ad-hoc invalidation; mutations should prefer
   * {@link afterMutation}. */
  invalidate(resources: readonly AdminResource[]): void {
    for (const resource of resources) {
      const key = this.keyFor(resource);
      const previous = this.entries.get(key);
      this.entries.set(key, {
        version: (previous?.version ?? 0) + 1,
        value: previous?.value,
        stale: true,
      });
      this.notifyResource(key);
    }
  }

  /**
   * Applies a successful mutation: invalidates exactly the resources the rule
   * names and raises the durable notification for it. Returns the resources
   * invalidated and the application timing, so the caller can trigger refetches
   * and render the right banner. The actual network refetch is the caller's job
   * (it owns the client); this layer owns the rules.
   */
  afterMutation(
    mutation: AdminMutation,
    subject: string,
  ): { invalidated: readonly AdminResource[]; timing: ApplicationTiming } {
    const invalidated = resourcesForMutation(mutation);
    this.invalidate(invalidated);
    this.raise({
      message: mutationNotification(mutation, subject),
      timing: timingForMutation(mutation),
      mutation,
    });
    return { invalidated, timing: timingForMutation(mutation) };
  }

  /**
   * Reconciles a background action's terminal status into the cache: on
   * success, invalidates the mutation's resources and raises its notification;
   * on failure, raises an ERROR notification with the action's safe message so
   * the failure is visible inline rather than lost. Call this from the
   * lifecycle layer after `pollAction` resolves.
   */
  afterAction(
    mutation: AdminMutation,
    subject: string,
    status: HermesActionStatus,
  ): { invalidated: readonly AdminResource[] } {
    if (status.state === "failed") {
      this.raise({
        message: status.error ?? `Could not finish ${subject}.`,
        timing: timingForMutation(mutation),
        mutation,
        isError: true,
      });
      return { invalidated: [] };
    }
    const { invalidated } = this.afterMutation(mutation, subject);
    return { invalidated };
  }

  /** Subscribes to a single resource's changes (set or invalidate). Returns an
   * unsubscribe function. */
  subscribe(resource: AdminResource, listener: () => void): () => void {
    const key = this.keyFor(resource);
    let set = this.resourceSubscribers.get(key);
    if (!set) {
      set = new Set();
      this.resourceSubscribers.set(key, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** The current durable notifications, newest last. */
  getNotifications(): readonly AdminNotification[] {
    return this.notifications;
  }

  /** Subscribes to the notification list. Fires with the full list on change. */
  subscribeNotifications(
    listener: (notifications: readonly AdminNotification[]) => void,
  ): () => void {
    this.notificationSubscribers.add(listener);
    return () => {
      this.notificationSubscribers.delete(listener);
    };
  }

  /** Dismisses a notification by id. */
  dismissNotification(id: string): void {
    const index = this.notifications.findIndex((n) => n.id === id);
    if (index >= 0) {
      this.notifications.splice(index, 1);
      this.notifyNotifications();
    }
  }

  /** Raises a durable notification. */
  private raise(input: Omit<AdminNotification, "id" | "at">): void {
    this.notifications.push({
      ...input,
      id: `admin-note-${++this.notificationSeq}`,
      at: Date.now(),
    });
    this.notifyNotifications();
  }

  private notifyResource(key: ResourceKey): void {
    const set = this.resourceSubscribers.get(key);
    if (!set) return;
    for (const listener of [...set]) listener();
  }

  private notifyNotifications(): void {
    const snapshot = [...this.notifications];
    for (const listener of [...this.notificationSubscribers]) {
      listener(snapshot);
    }
  }
}
