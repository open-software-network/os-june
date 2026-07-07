/**
 * Data hook behind June's Hermes profile manager. It owns the load / activate /
 * remove lifecycle for one {@link HermesAdminTarget}, using the same admin
 * foundation as the other native settings surfaces:
 *
 * - {@link HermesAdminClient} `profiles.list()` / `active()` / `activate()` /
 *   `remove()` for I/O, never a raw fetch;
 * - {@link AdminStateCache} for the profile list, keyed by the target identity
 *   so profile data from one runtime never appears under another;
 * - the pure guards in `profile-manager-view` so the UI and controller block
 *   the same no-op or destructive actions.
 *
 * The active profile comes from `GET /api/profiles/active`, not from the list's
 * `active` flag. Hermes may use the list flag for the dashboard's current
 * scoped profile; June's switcher needs the sticky active default.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { setActiveHermesProfileName } from "../active-hermes-profile";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import { AdminStateCache } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import { canActivateProfile, canRemoveProfile, orderProfiles } from "./profile-manager-view";
import { createRustAdminFetch } from "./rust-transport";
import type { HermesProfileSummary } from "./schemas";
import { adminTargetForMode, type HermesAdminMode, type HermesAdminTarget } from "./target";

/** The wired-up primitives one profile manager operates on. Tests build this
 * from the fake Hermes server; production derives it from bridge status. */
export type ProfileManagerEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
};

/** Loading/availability status. A missing runtime is `unavailable`, not an
 * error. */
export type ProfileManagerStatus = "unavailable" | "loading" | "ready" | "error";

export type ProfileManagerPendingAction = {
  kind: "activate" | "remove";
  name: string;
};

/** Everything the future profile-manager UI renders, plus actions it invokes. */
export type ProfileManagerState = {
  status: ProfileManagerStatus;
  profiles: HermesProfileSummary[];
  activeName: string;
  activeConfirmed: boolean;
  pendingAction: ProfileManagerPendingAction | null;
  error: string | null;
  activate(name: string): Promise<boolean>;
  remove(name: string): Promise<boolean>;
  refresh(): void;
  dismissError(): void;
};

/**
 * Framework-free controller the hook wraps. It keeps updates pessimistic: an
 * action only changes state after Hermes accepts it and the relevant list or
 * active pointer has been re-read.
 */
export class ProfileManagerController {
  private readonly engine: ProfileManagerEngine;
  private profiles: HermesProfileSummary[] = [];
  private activeName = "default";
  private activeConfirmed = false;
  private status: ProfileManagerStatus = "loading";
  private pendingAction: ProfileManagerPendingAction | null = null;
  private error: string | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: ProfileManagerState;

  constructor(engine: ProfileManagerEngine) {
    this.engine = engine;
    this.snapshot = this.buildSnapshot();

    this.unsubscribers.push(
      engine.cache.subscribe("profiles", () => {
        if (this.engine.cache.isStale("profiles")) {
          void this.load();
        }
      }),
    );
  }

  getSnapshot(): ProfileManagerState {
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

  /** Loads the ordered profile list and the sticky active profile. Seeds the
   * list from cache first so a manual refresh does not blank existing rows. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.activeConfirmed = false;
    const cached = this.engine.cache.get<HermesProfileSummary[]>("profiles");
    if (cached) {
      this.profiles = orderProfiles(cached);
      this.status = "ready";
      this.recompute();
    } else {
      this.status = "loading";
      this.recompute();
    }

    const [profilesResult, activeResult] = await Promise.allSettled([
      this.engine.client.profiles.list(),
      this.engine.client.profiles.active(),
    ]);
    if (this.disposed || seq !== this.loadSeq) return;

    if (profilesResult.status === "fulfilled") {
      const ordered = orderProfiles(profilesResult.value);
      this.engine.cache.set("profiles", ordered);
      this.profiles = ordered;
    }

    if (activeResult.status === "fulfilled") {
      this.activeName = activeResult.value.active || "default";
      this.activeConfirmed = true;
    } else {
      this.activeConfirmed = false;
    }

    if (profilesResult.status === "fulfilled") {
      this.status = "ready";
      this.error =
        activeResult.status === "rejected"
          ? HermesAdminError.from("GET /api/profiles/active", activeResult.reason).safeMessage
          : null;
    } else {
      const adminError = HermesAdminError.from("GET /api/profiles", profilesResult.reason);
      this.error = adminError.safeMessage;
      this.status = this.profiles.length > 0 ? "ready" : "error";
    }
    this.recompute();
  }

  async activate(name: string): Promise<boolean> {
    const guard = canActivateProfile(name, this.activeName, this.activeConfirmed);
    if (!guard.ok) {
      this.error = guard.reason;
      this.recompute();
      return false;
    }

    this.pendingAction = { kind: "activate", name };
    this.error = null;
    this.recompute();
    try {
      await this.engine.client.profiles.activate(name);
      setActiveHermesProfileName(name);
      if (this.disposed) return true;
      this.pendingAction = null;
      await this.load();
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.pendingAction = null;
      const adminError = HermesAdminError.from("POST /api/profiles/active", error);
      this.error = adminError.safeMessage;
      this.recompute();
      return false;
    }
  }

  async remove(name: string): Promise<boolean> {
    const guard = canRemoveProfile(name, this.activeName, this.activeConfirmed);
    if (!guard.ok) {
      this.error = guard.reason;
      this.recompute();
      return false;
    }

    this.pendingAction = { kind: "remove", name };
    this.error = null;
    this.recompute();
    try {
      await this.engine.client.profiles.remove(name);
      if (this.disposed) return true;
      this.pendingAction = null;
      await this.load();
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.pendingAction = null;
      const adminError = HermesAdminError.from(`DELETE /api/profiles/${name}`, error);
      this.error = adminError.safeMessage;
      this.recompute();
      return false;
    }
  }

  dismissError(): void {
    this.error = null;
    this.recompute();
  }

  private buildSnapshot(): ProfileManagerState {
    return {
      status: this.status,
      profiles: this.profiles,
      activeName: this.activeName,
      activeConfirmed: this.activeConfirmed,
      pendingAction: this.pendingAction,
      error: this.error,
      activate: this.activateAction,
      remove: this.removeAction,
      refresh: this.refresh,
      dismissError: this.dismissErrorAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private readonly activateAction = (name: string): Promise<boolean> => this.activate(name);
  private readonly removeAction = (name: string): Promise<boolean> => this.remove(name);
  private readonly refresh = (): void => {
    void this.load();
  };
  private readonly dismissErrorAction = (): void => {
    this.dismissError();
  };
}

/** Binds a {@link ProfileManagerController} to React for one engine. */
export function useProfileManagerController(
  engine: ProfileManagerEngine | null,
): ProfileManagerState {
  const controller = useMemo(
    () => (engine ? new ProfileManagerController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<ProfileManagerState>(() =>
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
const UNAVAILABLE_STATE: ProfileManagerState = Object.freeze({
  status: "unavailable",
  profiles: [],
  activeName: "default",
  activeConfirmed: false,
  pendingAction: null,
  error: null,
  activate: () => Promise.resolve(false),
  remove: () => Promise.resolve(false),
  refresh: () => {},
  dismissError: () => {},
}) as ProfileManagerState;

/** Production helper: derives a profile-manager engine from bridge status. */
export function useProfileManagerEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): ProfileManagerEngine | null {
  const target = useMemo(
    () => (bridge ? adminTargetForMode(bridge, mode, profile) : undefined),
    [bridge, mode, profile],
  );
  return useMemo(() => {
    if (!target) return null;
    const client = createHermesAdminClient(target, {
      fetch: createRustAdminFetch(target.mode),
    });
    const cache = new AdminStateCache(target);
    return { target, client, cache };
  }, [target]);
}

/** All-in-one production hook. Tests prefer {@link useProfileManagerController}
 * with a fake-server engine so they need no Tauri mock. */
export function useProfileManager(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): ProfileManagerState {
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
          setBridgeError(error instanceof Error ? error.message : String(error));
          loaded.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useProfileManagerEngine(bridge, mode, profile);
  const state = useProfileManagerController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError };
  }
  return state;
}
