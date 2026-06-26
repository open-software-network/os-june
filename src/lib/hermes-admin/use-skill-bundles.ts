/**
 * The data hook behind June's native Skill Bundles manager (admin surfaces spec
 * 11). It owns the load / create / edit / delete / duplicate / reload lifecycle
 * for one runtime/profile, plus "start chat with this bundle".
 *
 * Unlike the Skills/MCP surfaces, bundles have no dashboard REST endpoints, so
 * the writes go through the narrow Tauri bridge commands
 * (`hermes_list_skill_bundles` / `hermes_save_skill_bundle` /
 * `hermes_delete_skill_bundle`) rather than the admin HTTP client. The installed
 * skill list (loaded through the same `hermes_bridge_skills` command the rest of
 * June uses) is still needed to resolve member status, missing-skill warnings,
 * and slug collisions, so this hook loads both.
 *
 * Targeting is explicit: the mode selects the runtime (sandboxed vs
 * unrestricted); there is no first-connection fallback. A missing runtime
 * renders the "Hermes not running" state rather than guessing one.
 *
 * The controller is framework-free and unit-testable: a test injects fake
 * `list` / `save` / `remove` / `loadSkills` / `startChat` functions and drives
 * the create/edit/delete/duplicate flows with no Tauri and no rendering. The
 * hook is a thin binding over it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hermesBridgeStatus,
  hermesDeleteSkillBundle,
  hermesListSkillBundles,
  hermesSaveSkillBundle,
  type HermesBridgeStatus,
  type HermesSkillBundleDto,
} from "../tauri";
import type { AdminNotification } from "./cache";
import { createHermesAdminClient } from "./client";
import { createRustAdminFetch } from "./rust-transport";
import type { HermesSkillInfo } from "./schemas";
import {
  duplicateBundle,
  resolveBundle,
  validateBundleDraft,
  bundleChatPrompt,
  type SkillBundle,
  type ResolvedSkillBundle,
} from "./skill-bundles-view";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The bridge I/O the controller needs, injectable so a test can drive it with
 * fakes and assert the create/edit/delete/duplicate/start-chat wiring without a
 * Tauri runtime. */
export type SkillBundlesIo = {
  list: () => Promise<HermesSkillBundleDto[]>;
  loadSkills: () => Promise<HermesSkillInfo[]>;
  save: (
    bundle: SkillBundle,
    previousSlug: string | undefined,
  ) => Promise<HermesSkillBundleDto>;
  remove: (slug: string) => Promise<void>;
  /** Submits the bundle's slash command as a new chat. Provided by the host so
   * the hook stays decoupled from the chat workspace. */
  startChat: (prompt: string) => void;
};

/** Loading/availability status of the manager. A missing runtime ("unavailable")
 * is not an error and not empty. */
export type SkillBundlesStatus = "unavailable" | "loading" | "ready" | "error";

/** Everything the manager component renders plus the actions it invokes. */
export type SkillBundlesState = {
  status: SkillBundlesStatus;
  /** The bundles, resolved against the installed skills (member status, slug
   * collision, slash-command preview), sorted by slug. */
  bundles: ResolvedSkillBundle[];
  /** The installed skills, for the editor's member picker and validation. */
  skills: HermesSkillInfo[];
  mode?: HermesAdminMode;
  profile?: string;
  /** Slugs with a write/delete in flight. */
  pending: ReadonlySet<string>;
  error?: string;
  retryable: boolean;
  notifications: readonly AdminNotification[];
  /** Reloads bundles and skills from Hermes (the "Reload" / rescan action). */
  refresh: () => void;
  /** Creates or updates a bundle. `previousSlug` (when renaming) removes the old
   * file. Resolves to the saved bundle on success, or throws a safe message. */
  save: (
    draft: SkillBundle,
    previousSlug?: string,
  ) => Promise<HermesSkillBundleDto>;
  /** Deletes a bundle by slug. */
  remove: (slug: string) => Promise<void>;
  /** Duplicates a bundle (fresh slug) and saves the copy. */
  duplicate: (slug: string) => Promise<void>;
  /** Starts a chat that runs the bundle's slash command. */
  startChat: (slug: string) => void;
  /** Validates a draft against the loaded skills + other bundle slugs. */
  validate: (
    draft: SkillBundle,
    editingSlug?: string,
  ) => ReturnType<typeof validateBundleDraft>;
  dismissNotification: (id: string) => void;
};

let bundleNotificationSeq = 0;

/** Builds a durable, sentence-case change notice for the toast surface. Bundles
 * apply to new sessions (Hermes reads the bundle index at session start), so the
 * timing copy says so. */
function bundleNotification(
  message: string,
  isError = false,
): AdminNotification {
  bundleNotificationSeq += 1;
  return {
    id: `bundle-${Date.now()}-${bundleNotificationSeq}`,
    message,
    timing: "next-session",
    // Bundles have no dedicated mutation in the timing map; the toast surface
    // only reads id/message/isError, so a representative next-session mutation
    // is fine here.
    mutation: "config.set",
    at: Date.now(),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The framework-free controller. Holds the load state for one runtime/profile
 * and notifies a single subscriber (the hook) on change.
 */
export class SkillBundlesController {
  private readonly io: SkillBundlesIo;
  private readonly mode: HermesAdminMode;
  private readonly profile: string | undefined;
  private bundles: HermesSkillBundleDto[] = [];
  private skills: HermesSkillInfo[] = [];
  private status: SkillBundlesStatus = "loading";
  private error?: string;
  private retryable = false;
  private readonly pending = new Set<string>();
  private notifications: AdminNotification[] = [];
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private snapshot: SkillBundlesState;

  constructor(io: SkillBundlesIo, mode: HermesAdminMode, profile?: string) {
    this.io = io;
    this.mode = mode;
    this.profile = profile;
    this.snapshot = this.buildSnapshot();
  }

  getSnapshot(): SkillBundlesState {
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
    this.listeners.clear();
  }

  /** Loads bundles + skills. Skills are loaded best-effort: a skills failure
   * does not block the bundle list (membership just shows everything missing),
   * so the page is still usable. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    if (this.bundles.length === 0 && this.skills.length === 0) {
      this.status = "loading";
      this.recompute();
    }
    try {
      const [bundles, skills] = await Promise.all([
        this.io.list(),
        this.io.loadSkills().catch(() => [] as HermesSkillInfo[]),
      ]);
      if (this.disposed || seq !== this.loadSeq) return;
      this.bundles = sortBundles(bundles);
      this.skills = skills;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      this.error = safeMessage(error, "Could not load bundles from Hermes.");
      this.retryable = true;
      this.status = this.bundles.length > 0 ? "ready" : "error";
      this.recompute();
    }
  }

  async save(
    draft: SkillBundle,
    previousSlug?: string,
  ): Promise<HermesSkillBundleDto> {
    const slug = draft.slug.trim();
    this.pending.add(slug);
    this.error = undefined;
    this.recompute();
    try {
      const saved = await this.io.save(normalizeDraft(draft), previousSlug);
      if (this.disposed) return saved;
      this.pending.delete(slug);
      this.notifications = [
        ...this.notifications,
        bundleNotification(
          `Saved /${saved.slug}. New sessions can use this bundle.`,
        ),
      ];
      await this.load();
      return saved;
    } catch (error) {
      if (!this.disposed) {
        this.pending.delete(slug);
        const message = safeMessage(error, "Could not save the bundle.");
        this.error = message;
        this.notifications = [
          ...this.notifications,
          bundleNotification(message, true),
        ];
        this.recompute();
      }
      throw error;
    }
  }

  async remove(slug: string): Promise<void> {
    const key = slug.trim();
    this.pending.add(key);
    this.error = undefined;
    this.recompute();
    try {
      await this.io.remove(key);
      if (this.disposed) return;
      this.pending.delete(key);
      this.notifications = [
        ...this.notifications,
        bundleNotification(`Deleted /${key}. New sessions will not load it.`),
      ];
      await this.load();
    } catch (error) {
      if (!this.disposed) {
        this.pending.delete(key);
        const message = safeMessage(error, "Could not delete the bundle.");
        this.error = message;
        this.notifications = [
          ...this.notifications,
          bundleNotification(message, true),
        ];
        this.recompute();
      }
      throw error;
    }
  }

  async duplicate(slug: string): Promise<void> {
    const source = this.bundles.find((bundle) => bundle.slug === slug);
    if (!source) return;
    const copy = duplicateBundle(
      toBundle(source),
      this.bundles.map((bundle) => bundle.slug),
    );
    await this.save(copy);
  }

  startChat(slug: string): void {
    const bundle = this.bundles.find((entry) => entry.slug === slug);
    if (!bundle) return;
    this.io.startChat(bundleChatPrompt(toBundle(bundle)));
  }

  validate(draft: SkillBundle, editingSlug?: string) {
    const existingSlugs = this.bundles
      .map((bundle) => bundle.slug)
      .filter((existing) => existing !== editingSlug);
    return validateBundleDraft(draft, {
      skills: this.skills,
      existingSlugs,
    });
  }

  dismissNotification(id: string): void {
    this.notifications = this.notifications.filter((note) => note.id !== id);
    this.recompute();
  }

  private buildSnapshot(): SkillBundlesState {
    const resolved = this.bundles.map((bundle) =>
      resolveBundle(toBundle(bundle), this.skills),
    );
    return {
      status: this.status,
      bundles: resolved,
      skills: this.skills,
      mode: this.mode,
      profile: this.profile,
      pending: new Set(this.pending),
      error: this.error,
      retryable: this.retryable,
      notifications: this.notifications,
      refresh: this.refreshAction,
      save: this.saveAction,
      remove: this.removeAction,
      duplicate: this.duplicateAction,
      startChat: this.startChatAction,
      validate: this.validateAction,
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
  private readonly saveAction = (draft: SkillBundle, previousSlug?: string) =>
    this.save(draft, previousSlug);
  private readonly removeAction = (slug: string) => this.remove(slug);
  private readonly duplicateAction = (slug: string) => this.duplicate(slug);
  private readonly startChatAction = (slug: string): void =>
    this.startChat(slug);
  private readonly validateAction = (
    draft: SkillBundle,
    editingSlug?: string,
  ) => this.validate(draft, editingSlug);
  private readonly dismissNotificationAction = (id: string): void =>
    this.dismissNotification(id);
}

/** Binds a {@link SkillBundlesController} to React. A null io yields the
 * "unavailable" state without constructing a controller. */
export function useSkillBundlesController(
  io: SkillBundlesIo | null,
  mode: HermesAdminMode,
  profile?: string,
): SkillBundlesState {
  const controller = useMemo(
    () => (io ? new SkillBundlesController(io, mode, profile) : null),
    [io, mode, profile],
  );

  const [snapshot, setSnapshot] = useState<SkillBundlesState>(() =>
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
const UNAVAILABLE_STATE: SkillBundlesState = Object.freeze({
  status: "unavailable",
  bundles: [],
  skills: [],
  pending: new Set<string>(),
  retryable: false,
  notifications: [],
  refresh: () => {},
  save: async () => {
    throw new Error("Hermes is not running.");
  },
  remove: async () => {},
  duplicate: async () => {},
  startChat: () => {},
  validate: (draft: SkillBundle) =>
    validateBundleDraft(draft, { skills: [], existingSlugs: [] }),
  dismissNotification: () => {},
}) as SkillBundlesState;

/**
 * Production hook: derives the bridge target for a mode, builds the Tauri-backed
 * io, and runs the controller. `onStartChat` is the host's "start a new chat
 * with this prompt" callback (the bundle slash command). Returns the
 * "unavailable" state when that mode is not running.
 */
export function useSkillBundles(
  mode: HermesAdminMode = "sandboxed",
  onStartChat?: (prompt: string) => void,
  profile?: string,
): SkillBundlesState {
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
  const identity = target ? `${target.mode}:${target.profile}` : null;
  const startChat = useStableStartChat(onStartChat);

  const io = useMemo<SkillBundlesIo | null>(() => {
    if (!target) return null;
    const requestProfile =
      target.profile && target.profile !== "default"
        ? target.profile
        : undefined;
    // Bundles are written through the narrow Tauri bridge commands; the
    // installed-skill list (for member resolution / warnings) comes through the
    // same admin client every other surface uses, routed through Rust so the
    // cross-origin dashboard does not 401 a webview fetch.
    const adminClient = createHermesAdminClient(target, {
      fetch: createRustAdminFetch(target.mode),
    });
    return {
      list: () =>
        hermesListSkillBundles({ mode: target.mode, profile: requestProfile }),
      loadSkills: () => adminClient.skills.list(),
      save: (bundle, previousSlug) =>
        hermesSaveSkillBundle({
          mode: target.mode,
          profile: requestProfile,
          bundle,
          previousSlug,
        }),
      remove: (slug) =>
        hermesDeleteSkillBundle({
          mode: target.mode,
          profile: requestProfile,
          slug,
        }),
      startChat,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity
  }, [identity, startChat]);

  const state = useSkillBundlesController(io, mode, profile);

  if (io === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}

/** Keeps a stable identity for the host's start-chat callback so the io memo
 * does not churn when the parent re-renders with a new closure. */
function useStableStartChat(
  onStartChat?: (prompt: string) => void,
): (prompt: string) => void {
  const ref = useRef(onStartChat);
  ref.current = onStartChat;
  return useCallback((prompt: string) => {
    ref.current?.(prompt);
  }, []);
}

function toBundle(dto: HermesSkillBundleDto): SkillBundle {
  return {
    slug: dto.slug,
    name: dto.name,
    description: dto.description,
    skills: [...dto.skills],
    instructions: dto.instructions,
  };
}

/** Strips empty trailing fields and trims the slug before a write so the saved
 * YAML is clean and the slug is exactly what the bridge validates. */
function normalizeDraft(draft: SkillBundle): SkillBundle {
  return {
    slug: draft.slug.trim(),
    name: draft.name?.trim() || undefined,
    description: draft.description?.trim() || undefined,
    skills: draft.skills.map((skill) => skill.trim()).filter(Boolean),
    instructions: draft.instructions?.trim() || undefined,
  };
}

function sortBundles(bundles: HermesSkillBundleDto[]): HermesSkillBundleDto[] {
  return [...bundles].sort((a, b) => a.slug.localeCompare(b.slug));
}

function safeMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
