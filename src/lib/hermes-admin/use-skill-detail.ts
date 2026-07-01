/**
 * The data hook + framework-free controller behind the skill detail viewer and
 * safe editor (spec 05). For ONE skill on ONE {@link HermesAdminTarget}, it:
 *
 * - loads the skill's raw SKILL.md text through the {@link HermesAdminClient}
 *   (`GET /api/skills/content`) — never a raw `fetch`, always the Rust proxy;
 * - derives the edit policy from the skill's source/read-only state, so
 *   read-only is ENFORCED (save is impossible) rather than only styled;
 * - validates an edit (frontmatter, required fields, size, secret-looking
 *   values) BEFORE any save, and exposes a diff for the diff-before-save
 *   confirmation;
 * - saves through `skills.updateContent`, routing the mutation through the
 *   shared cache invalidation + durable notification + gateway-lifecycle banner
 *   so the apply-timing copy ("applies next session") is honest and consistent
 *   with every other admin surface.
 *
 * SECRET SAFETY: the editor's draft is held only in controller state and sent
 * verbatim on save; nothing here logs the content. The secret SCAN reports line
 * numbers only, never the matched value, so a "looks like a secret" warning can
 * surface without leaking it.
 */

import { useEffect, useMemo, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import { createRustAdminFetch } from "./rust-transport";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import {
  diffSkillContent,
  skillEditPolicy,
  skillSupportingFiles,
  splitSkillDocument,
  validateSkillContent,
  type SkillContentValidation,
  type SkillDiff,
  type SkillDocumentParts,
  type SkillEditPolicy,
  type SkillSupportingFiles,
} from "./skill-detail-view";
import type { HermesSkillInfo, HermesSkillSource } from "./schemas";
import type { SkillSetupEngine } from "./use-skill-setup";
import { adminTargetForMode, type HermesAdminMode } from "./target";

/** The detail surface operates on the same wired primitives as the setup panel,
 * so it reuses that engine shape (target + client + cache + lifecycle, all bound
 * to ONE target). */
export type SkillDetailEngine = SkillSetupEngine;

export type SkillDetailStatusKind = "loading" | "ready" | "error";

/** Everything the detail viewer/editor renders, plus the actions it invokes. A
 * pure projection of the controller's state. The draft content IS carried (it
 * is non-secret SKILL.md text the editor binds to), but no secret is derived
 * from it here. */
export type SkillDetailState = {
  status: SkillDetailStatusKind;
  /** The skill name this surface is for. */
  skill: string;
  /** The skill's inventory metadata (name, description, version, source, ...),
   * when the host passed it. The header renders from this. */
  info?: HermesSkillInfo;
  /** The on-disk relative path the content was read from, when reported. */
  relativePath?: string;
  /** The loaded SKILL.md as last read from Hermes (the save baseline + the diff
   * "before"). Empty string until loaded. */
  original: string;
  /** The current editor draft. Equal to `original` until the user edits. */
  draft: string;
  /** The split of the loaded document for the read view (frontmatter + body). */
  parts: SkillDocumentParts;
  /** The skill's grouped supporting files, derived from its inventory payload. */
  supportingFiles: SkillSupportingFiles;
  /** Whether and how June may write this skill (ENFORCED, not cosmetic). */
  policy: SkillEditPolicy;
  /** Validation of the current draft (errors block save; warnings do not). */
  validation: SkillContentValidation;
  /** The diff from `original` to `draft`, for the confirm-before-save dialog. */
  diff: SkillDiff;
  /** True when the draft differs from what was loaded. */
  dirty: boolean;
  /** True while a save is in flight. */
  saving: boolean;
  /** The targeted mode + profile, so a write's blast radius is explicit. */
  mode: HermesAdminMode;
  profile: string;
  /** A safe error message for a load/save failure, or undefined. */
  error?: string;
  /** Whether the last failure is retryable. */
  retryable: boolean;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  /** Reloads the SKILL.md from Hermes, discarding nothing the user has typed
   * unless they were unchanged (the controller keeps the draft if it differs). */
  refresh: () => void;
  /** Updates the editor draft (no network). */
  setDraft: (next: string) => void;
  /** Reverts the draft back to the loaded original. */
  revert: () => void;
  /** Saves the draft. A no-op when read-only, unchanged, or invalid. */
  save: () => void;
  dismissNotification: (id: string) => void;
};

const EMPTY_PARTS: SkillDocumentParts = {
  body: "",
  hasFrontmatter: false,
};

/**
 * The framework-free controller. Loads the document, tracks the draft, and
 * saves through the foundation client. Mirrors {@link SkillSetupController}'s
 * subscribe/getSnapshot/dispose contract so the React binding is identical.
 */
export class SkillDetailController {
  private readonly engine: SkillDetailEngine;
  private readonly skill: string;
  private readonly info?: HermesSkillInfo;
  private readonly source: HermesSkillSource;
  private readonly hardReadOnly: boolean;
  private status: SkillDetailStatusKind = "loading";
  private original = "";
  private draft = "";
  private relativePath?: string;
  private saving = false;
  private error?: string;
  private retryable = false;
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: SkillDetailState;

  constructor(
    engine: SkillDetailEngine,
    skill: string,
    info?: HermesSkillInfo,
  ) {
    this.engine = engine;
    this.skill = skill;
    this.info = info;
    this.source = info?.source ?? "unknown";
    this.hardReadOnly = Boolean(info?.readOnly);
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
  }

  getSnapshot(): SkillDetailState {
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

  /** Loads the SKILL.md text. A refresh keeps the user's draft when it differs
   * from the freshly-loaded original (so a background reload never silently
   * discards in-progress edits); when the draft was clean, it tracks the new
   * original. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const wasDirty = this.draft !== this.original;
    if (this.original === "" && this.draft === "") {
      this.status = "loading";
      this.recompute();
    }
    try {
      const content = await this.engine.client.skills.getContent(this.skill);
      if (this.disposed || seq !== this.loadSeq) return;
      this.original = content.content;
      this.relativePath = content.relativePath;
      if (!wasDirty) this.draft = content.content;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from(
        "GET /api/skills/content",
        error,
      );
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      // Keep any already-loaded content on screen; only hard-fail when empty.
      this.status = this.original ? "ready" : "error";
      this.recompute();
    }
  }

  setDraft(next: string): void {
    if (next === this.draft) return;
    this.draft = next;
    // Clear a stale save error as soon as the user edits again.
    if (this.error) this.error = undefined;
    this.recompute();
  }

  revert(): void {
    if (this.draft === this.original) return;
    this.draft = this.original;
    this.error = undefined;
    this.recompute();
  }

  /** Saves the draft. Enforces read-only and validation in LOGIC: a read-only
   * skill, an unchanged draft, or a draft with validation errors never reaches
   * the wire. */
  async save(): Promise<void> {
    if (this.saving || this.disposed) return;
    const policy = skillEditPolicy({
      source: this.source,
      readOnly: this.hardReadOnly,
    });
    if (!policy.editable) return;
    if (this.draft === this.original) return;
    const validation = this.validate();
    if (!validation.canSave) return;

    this.saving = true;
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.skills.updateContent(
        this.skill,
        this.draft,
      );
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, this.skill);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      // Track the saved content as the new baseline; reflect any normalization
      // Hermes applied on write.
      this.original = outcome.result.content;
      this.draft = outcome.result.content;
      this.relativePath = outcome.result.relativePath ?? this.relativePath;
      this.saving = false;
      this.recompute();
    } catch (error) {
      if (this.disposed) return;
      this.saving = false;
      const adminError = HermesAdminError.from(
        "PUT /api/skills/content",
        error,
      );
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  /** Validates the current draft against THIS skill's requirements. Name is
   * required when the loaded skill had one (or has a name at all); a description
   * is required only when the original declared one, so editing never forces a
   * description onto a skill that never had it. */
  private validate(): SkillContentValidation {
    const originalParts = splitSkillDocument(this.original);
    const originalScalars = originalParts.hasFrontmatter
      ? readFrontmatterHas(originalParts.frontmatter ?? "")
      : { name: false, description: false };
    return validateSkillContent(this.draft, {
      requireName: true,
      requireDescription: originalScalars.description,
    });
  }

  private buildSnapshot(): SkillDetailState {
    const policy = skillEditPolicy({
      source: this.source,
      readOnly: this.hardReadOnly,
    });
    const parts = this.original
      ? splitSkillDocument(this.original)
      : EMPTY_PARTS;
    const validation = this.validate();
    const diff = diffSkillContent(this.original, this.draft);
    return {
      status: this.status,
      skill: this.skill,
      info: this.info,
      relativePath: this.relativePath,
      original: this.original,
      draft: this.draft,
      parts,
      supportingFiles: this.info
        ? skillSupportingFiles(this.info)
        : EMPTY_SUPPORTING,
      policy,
      validation,
      diff,
      dirty: this.draft !== this.original,
      saving: this.saving,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refreshAction,
      setDraft: this.setDraftAction,
      revert: this.revertAction,
      save: this.saveAction,
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
  private readonly setDraftAction = (next: string): void => {
    this.setDraft(next);
  };
  private readonly revertAction = (): void => {
    this.revert();
  };
  private readonly saveAction = (): void => {
    void this.save();
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

const EMPTY_SUPPORTING: SkillSupportingFiles = {
  references: [],
  templates: [],
  scripts: [],
  assets: [],
  other: [],
};

/** Cheap "does frontmatter declare name/description" check, without pulling the
 * full scalar reader's return shape into this module. */
function readFrontmatterHas(frontmatter: string): {
  name: boolean;
  description: boolean;
} {
  const lower = frontmatter.toLowerCase();
  return {
    name: /^name\s*:\s*\S/m.test(lower),
    description: /^description\s*:\s*\S/m.test(lower),
  };
}

/** Binds a {@link SkillDetailController} to React for one engine + skill. A null
 * engine yields the unavailable state without constructing a controller. */
export function useSkillDetailController(
  engine: SkillDetailEngine | null,
  skill: string,
  info?: HermesSkillInfo,
): SkillDetailState {
  const controller = useMemo(
    () => (engine ? new SkillDetailController(engine, skill, info) : null),
    // Keyed by engine + skill; info identity changes per list refresh but its
    // metadata is stable for a given skill within a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, skill],
  );

  const [snapshot, setSnapshot] = useState<SkillDetailState>(() =>
    controller ? controller.getSnapshot() : unavailableState(skill, info),
  );

  useEffect(() => {
    if (!controller) {
      setSnapshot(unavailableState(skill, info));
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
    // `info` is intentionally excluded: its identity changes on every list poll
    // but its metadata is stable for a given skill, and the controller is keyed
    // on [engine, skill]. Re-subscribing per poll would churn the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, skill]);

  return snapshot;
}

/** The state shown when there is no runtime to talk to. */
function unavailableState(
  skill: string,
  info?: HermesSkillInfo,
): SkillDetailState {
  const policy = skillEditPolicy({
    source: info?.source ?? "unknown",
    readOnly: Boolean(info?.readOnly),
  });
  return {
    status: "error",
    skill,
    info,
    original: "",
    draft: "",
    parts: EMPTY_PARTS,
    supportingFiles: info ? skillSupportingFiles(info) : EMPTY_SUPPORTING,
    policy,
    validation: validateSkillContent("", {
      requireName: false,
      requireDescription: false,
    }),
    diff: diffSkillContent("", ""),
    dirty: false,
    saving: false,
    mode: "sandboxed",
    profile: "default",
    error: "Hermes is not running.",
    retryable: false,
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    refresh: () => {},
    setDraft: () => {},
    revert: () => {},
    save: () => {},
    dismissNotification: () => {},
  };
}

/** Production helper: derives the {@link SkillDetailEngine} for a chosen mode
 * from a live bridge status, returning null when that mode is not running.
 * Profile targeting is explicit via {@link adminTargetForMode}. */
export function useSkillDetailEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): SkillDetailEngine | null {
  const target = useMemo(
    () => (bridge ? adminTargetForMode(bridge, mode, profile) : undefined),
    [bridge, mode, profile],
  );
  const identity = target
    ? `${target.mode}:${target.profile}:${target.baseUrl}:${target.token}`
    : null;

  return useMemo(() => {
    if (!target) return null;
    // The detail surface shares the foundation primitives with every other
    // admin page; building them per identity here keeps the surface
    // self-contained while staying coherent through the shared cache.
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
 * the mode, and run the controller for one skill. The drawer calls THIS; tests
 * prefer {@link useSkillDetailController} with a harness engine. */
export function useSkillDetail(
  skill: string,
  info?: HermesSkillInfo,
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): SkillDetailState {
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

  const engine = useSkillDetailEngine(bridge, mode, profile);
  return useSkillDetailController(engine, skill, info);
}
