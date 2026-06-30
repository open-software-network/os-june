/**
 * The data + orchestration hook behind June's guided Profile Builder (spec 20).
 * It owns the wizard's input loading (existing profiles, the generation model
 * catalog, installed skills, MCP servers, the MCP catalog), the create
 * orchestration (`POST /api/profiles` then optional SOUL write then optional
 * test session), and the success/failure-with-rollback messaging.
 *
 * Everything user-facing and rule-based lives in the framework-free
 * {@link ProfileBuilderController}, so back/next/validation, the model
 * tool-calling gate, and create success/failure/rollback are unit-testable
 * without React. The pure step model and payload assembly live in
 * `./profile-builder-view`.
 *
 * Profile creation is a documented REST endpoint, so this never shells out or
 * copies directories: it reuses the same {@link HermesAdminClient} +
 * {@link AdminStateCache} foundation every admin surface uses, with explicit
 * profile/mode targeting (a builder run always talks to ONE chosen runtime).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  hermesBridgeStatus,
  listVeniceModels,
  type HermesBridgeStatus,
} from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import {
  buildCreatePayload,
  canAdvance,
  canCreateProfile,
  emptyProfileForm,
  nextStep,
  previousStep,
  slugifyProfileName,
  type ProfileBuilderContext,
  type ProfileBuilderForm,
  type ProfileBuilderModel,
  type ProfileBuilderStep,
} from "./profile-builder-view";
import { createRustAdminFetch } from "./rust-transport";
import type {
  HermesMcpCatalogEntry,
  HermesMcpServerInfo,
  HermesProfileSummary,
  HermesSkillInfo,
} from "./schemas";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** Loads the generation model catalog. Injected so tests drive the model gate
 * without a Tauri runtime; production uses `listVeniceModels("generation")`. */
export type LoadProfileBuilderModels = () => Promise<ProfileBuilderModel[]>;

/** The wired foundation primitives one builder operates on, all bound to the
 * SAME target. Production builds this from a bridge connection; tests build it
 * from the fake-server harness plus a stub model loader. */
export type ProfileBuilderEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
  /** Loads the generation model catalog. */
  loadModels: LoadProfileBuilderModels;
};

export type ProfileBuilderStatus =
  | "unavailable"
  | "loading"
  | "ready"
  | "error";

/** Where the create flow is. `creating` runs the create + soul + session calls;
 * `created` is the terminal success; `failed` carries a rolled-back message. */
export type CreatePhase = "idle" | "creating" | "created" | "failed";

export type CreateState = {
  phase: CreatePhase;
  /** Safe progress message while creating (e.g. "Writing instructions..."). */
  message?: string;
  /** Safe error message when `phase === "failed"`. */
  error?: string;
  /** The created profile's slug, set on success. */
  createdSlug?: string;
  /** True once a test session was started for the created profile. */
  testSessionStarted?: boolean;
};

/** Everything the Profile Builder component renders, plus the actions it
 * invokes. A pure projection of the controller's state. */
export type ProfileBuilderState = {
  status: ProfileBuilderStatus;
  mode?: HermesAdminMode;
  profile?: string;
  /** The user-safe message when `status === "error"`. */
  error?: string;
  retryable: boolean;
  /** The current wizard step. */
  step: ProfileBuilderStep;
  /** The mutable form. */
  form: ProfileBuilderForm;
  /** Loaded inputs for the steps. */
  existingProfiles: readonly HermesProfileSummary[];
  models: readonly ProfileBuilderModel[];
  skills: readonly HermesSkillInfo[];
  mcpServers: readonly HermesMcpServerInfo[];
  mcpCatalog: readonly HermesMcpCatalogEntry[];
  /** True when one of the step-input loads is still in flight. */
  inputsLoading: boolean;
  create: CreateState;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  // actions
  setStep: (step: ProfileBuilderStep) => void;
  goNext: () => void;
  goBack: () => void;
  update: (patch: Partial<ProfileBuilderForm>) => void;
  reset: () => void;
  refresh: () => void;
  /** Runs the create orchestration. `startTestSession` opts into starting a
   * session under the new profile after a successful create. */
  createProfile: (options?: { startTestSession?: boolean }) => void;
  dismissNotification: (id: string) => void;
};

/**
 * The framework-free controller. Holds the form, the loaded inputs, and the
 * create-flow state for one engine, and notifies one subscriber on change.
 */
export class ProfileBuilderController {
  private readonly engine: ProfileBuilderEngine;
  private status: ProfileBuilderStatus = "loading";
  private error?: string;
  private retryable = false;
  private step: ProfileBuilderStep = "identity";
  private form: ProfileBuilderForm = emptyProfileForm();
  private existingProfiles: readonly HermesProfileSummary[] = [];
  private models: readonly ProfileBuilderModel[] = [];
  private skills: readonly HermesSkillInfo[] = [];
  private mcpServers: readonly HermesMcpServerInfo[] = [];
  private mcpCatalog: readonly HermesMcpCatalogEntry[] = [];
  private inputsLoading = true;
  private create: CreateState = { phase: "idle" };
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: ProfileBuilderState;

  constructor(engine: ProfileBuilderEngine) {
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
  }

  getSnapshot(): ProfileBuilderState {
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

  /** Loads every step input. A model-catalog failure does not blank the page —
   * it leaves the model step unable to confirm tool support (the validation
   * warns), so the load is best-effort per source. The profiles list IS the
   * page's reason to exist (it gates the name), so its failure is the page
   * error. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.inputsLoading = true;
    this.status = this.existingProfiles.length > 0 ? "ready" : "loading";
    this.recompute();

    try {
      const profiles = await this.engine.client.profiles.list();
      if (this.disposed || seq !== this.loadSeq) return;
      this.existingProfiles = profiles;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from("GET /api/profiles", error);
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      this.status = this.existingProfiles.length > 0 ? "ready" : "error";
    }
    this.recompute();

    // The remaining inputs are enrichment for individual steps; a failure on any
    // leaves that step's choices empty rather than failing the whole builder.
    await Promise.all([
      this.loadModels(seq),
      this.loadSkills(seq),
      this.loadMcp(seq),
    ]);

    if (this.disposed || seq !== this.loadSeq) return;
    this.inputsLoading = false;
    this.recompute();
  }

  private async loadModels(seq: number): Promise<void> {
    try {
      const models = await this.engine.loadModels();
      if (this.disposed || seq !== this.loadSeq) return;
      this.models = models;
      this.recompute();
    } catch {
      // Leave models empty; the model step warns it cannot confirm tool support.
    }
  }

  private async loadSkills(seq: number): Promise<void> {
    try {
      const skills = await this.engine.client.skills.list();
      if (this.disposed || seq !== this.loadSeq) return;
      this.engine.cache.set("skills", skills);
      this.skills = skills;
      this.recompute();
    } catch {
      // Leave skills empty; the skills step shows nothing to keep/install.
    }
  }

  private async loadMcp(seq: number): Promise<void> {
    try {
      const [servers, catalog] = await Promise.all([
        this.engine.client.mcp.listServers(),
        this.engine.client.mcp.catalog(),
      ]);
      if (this.disposed || seq !== this.loadSeq) return;
      this.mcpServers = servers;
      this.mcpCatalog = catalog;
      this.recompute();
    } catch {
      // Leave MCP inputs empty; the MCP step shows nothing to attach.
    }
  }

  /** The validation context the view layer reads. */
  context(): ProfileBuilderContext {
    return { existingProfiles: this.existingProfiles, models: this.models };
  }

  setStep(step: ProfileBuilderStep): void {
    this.step = step;
    this.recompute();
  }

  update(patch: Partial<ProfileBuilderForm>): void {
    this.form = { ...this.form, ...patch };
    // A form edit invalidates a terminal failure so the user can retry cleanly.
    if (this.create.phase === "failed") this.create = { phase: "idle" };
    this.recompute();
  }

  reset(): void {
    this.form = emptyProfileForm();
    this.step = "identity";
    this.create = { phase: "idle" };
    this.recompute();
  }

  /**
   * Runs the create orchestration:
   *   1. POST /api/profiles (create the isolated profile)
   *   2. PUT /api/profiles/{slug}/soul when a custom SOUL was written
   *   3. POST /api/profiles/active + /open-terminal when a test session is asked
   *
   * On a step-1 failure nothing was created, so the message is a plain failure.
   * On a step-2/3 failure the profile DID get created, so the message says the
   * profile exists but the follow-up did not finish, and the user can complete
   * it from the profile's settings, rather than implying a clean rollback that
   * did not happen.
   */
  async createProfile(
    options: { startTestSession?: boolean } = {},
  ): Promise<void> {
    if (this.create.phase === "creating") return;
    if (!canCreateProfile(this.form, this.context())) {
      this.create = {
        phase: "failed",
        error: "Fix the highlighted steps before creating the profile.",
      };
      this.recompute();
      return;
    }

    const slug = slugifyProfileName(this.form.name);
    const payload = buildCreatePayload(this.form);
    this.create = { phase: "creating", message: "Creating profile..." };
    this.recompute();

    // Step 1: create. A failure here means nothing was written.
    try {
      const result = await this.engine.client.profiles.create(payload);
      this.engine.cache.afterMutation(result.mutation, result.result.name);
      this.engine.lifecycle.noteMutation(result.mutation);
    } catch (error) {
      if (this.disposed) return;
      const adminError = HermesAdminError.from("POST /api/profiles", error);
      this.create = {
        phase: "failed",
        error: `Could not create the profile: ${adminError.safeMessage} No changes were made.`,
      };
      this.recompute();
      return;
    }

    // Step 2: SOUL. The profile now exists; a failure here is NOT a clean
    // rollback, so the message says so.
    if (this.form.soul.trim()) {
      this.create = { phase: "creating", message: "Writing instructions..." };
      this.recompute();
      try {
        await this.engine.client.profiles.setSoul(slug, this.form.soul.trim());
      } catch (error) {
        if (this.disposed) return;
        const adminError = HermesAdminError.from(
          `PUT /api/profiles/${slug}/soul`,
          error,
        );
        this.create = {
          phase: "failed",
          createdSlug: slug,
          error: `Created the profile "${slug}", but saving its instructions failed: ${adminError.safeMessage} You can add them from the profile's settings.`,
        };
        this.recompute();
        return;
      }
    }

    // Step 3: optional test session. Same post-create semantics on failure.
    let testSessionStarted = false;
    if (options.startTestSession) {
      this.create = { phase: "creating", message: "Starting test session..." };
      this.recompute();
      try {
        await this.engine.client.profiles.startTestSession(slug);
        testSessionStarted = true;
      } catch (error) {
        if (this.disposed) return;
        const adminError = HermesAdminError.from(
          `POST /api/profiles/${slug}/open-terminal`,
          error,
        );
        this.create = {
          phase: "created",
          createdSlug: slug,
          testSessionStarted: false,
          message: `Created "${slug}". The test session did not start: ${adminError.safeMessage}`,
        };
        this.recompute();
        return;
      }
    }

    if (this.disposed) return;
    this.create = {
      phase: "created",
      createdSlug: slug,
      testSessionStarted,
      message: `Created "${slug}".`,
    };
    this.recompute();
  }

  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  private buildSnapshot(): ProfileBuilderState {
    return {
      status: this.status,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      error: this.error,
      retryable: this.retryable,
      step: this.step,
      form: this.form,
      existingProfiles: this.existingProfiles,
      models: this.models,
      skills: this.skills,
      mcpServers: this.mcpServers,
      mcpCatalog: this.mcpCatalog,
      inputsLoading: this.inputsLoading,
      create: this.create,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      setStep: this.setStepAction,
      goNext: this.goNextAction,
      goBack: this.goBackAction,
      update: this.updateAction,
      reset: this.resetAction,
      refresh: this.refreshAction,
      createProfile: this.createProfileAction,
      dismissNotification: this.dismissNotificationAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  // Stable action identities so the snapshot callbacks keep referential equality.
  private readonly setStepAction = (step: ProfileBuilderStep): void => {
    this.setStep(step);
  };
  private readonly goNextAction = (): void => {
    // Advance only when the current step permits it; the view disables the
    // button, but the controller enforces the gate too.
    if (canAdvance(this.step, this.form, this.context())) {
      this.setStep(nextStep(this.step));
    }
  };
  private readonly goBackAction = (): void => {
    this.setStep(previousStep(this.step));
  };
  private readonly updateAction = (
    patch: Partial<ProfileBuilderForm>,
  ): void => {
    this.update(patch);
  };
  private readonly resetAction = (): void => {
    this.reset();
  };
  private readonly refreshAction = (): void => {
    void this.load();
  };
  private readonly createProfileAction = (options?: {
    startTestSession?: boolean;
  }): void => {
    void this.createProfile(options);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/** Binds a {@link ProfileBuilderController} to React for one engine. */
export function useProfileBuilderController(
  engine: ProfileBuilderEngine | null,
): ProfileBuilderState {
  const controller = useMemo(
    () => (engine ? new ProfileBuilderController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<ProfileBuilderState>(() =>
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

const UNAVAILABLE_STATE: ProfileBuilderState = Object.freeze({
  status: "unavailable",
  retryable: false,
  step: "identity",
  form: emptyProfileForm(),
  existingProfiles: [],
  models: [],
  skills: [],
  mcpServers: [],
  mcpCatalog: [],
  inputsLoading: false,
  create: { phase: "idle" },
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  setStep: () => {},
  goNext: () => {},
  goBack: () => {},
  update: () => {},
  reset: () => {},
  refresh: () => {},
  createProfile: () => {},
  dismissNotification: () => {},
}) as ProfileBuilderState;

/** Production model loader: the generation catalog mapped down to the builder's
 * model shape. */
async function loadGenerationModels(): Promise<ProfileBuilderModel[]> {
  const response = await listVeniceModels("generation");
  return response.models.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    capabilities: model.capabilities ?? [],
  }));
}

/** Production helper: derives the engine for a chosen mode from a bridge status,
 * returning null when that mode is not running. Profile targeting is explicit
 * via {@link adminTargetForMode}. */
export function useProfileBuilderEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): ProfileBuilderEngine | null {
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
    return {
      target,
      client,
      cache,
      lifecycle,
      loadModels: loadGenerationModels,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity
  }, [identity]);
}

/** The all-in-one production hook: fetch bridge status, derive the engine for
 * the mode, and run the controller. */
export function useProfileBuilder(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): ProfileBuilderState {
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

  const engine = useProfileBuilderEngine(bridge, mode, profile);
  const state = useProfileBuilderController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
