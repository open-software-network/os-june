import { IconArrowLeft } from "central-icons/IconArrowLeft";
import { IconArrowRight } from "central-icons/IconArrowRight";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconRobot2 } from "central-icons/IconRobot2";
import { IconTrashCan } from "central-icons/IconTrashCan";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  STEP_META,
  attachableMcpServers,
  buildCreatePlan,
  bundledSkillOptions,
  canActivateProfile,
  canCreateProfile,
  canRemoveProfile,
  describeProfile,
  selectedModelToolSupport,
  slugifyProfileName,
  useProfileBuilder,
  useProfileManager,
  validateProfileName,
  validateStep,
  type ChangeRisk,
  type HermesAdminMode,
  type ProfileBuilderState,
  type ProfileBuilderStep,
  type ProfileManagerState,
} from "../../lib/hermes-admin";
import {
  deleteProfileModelOverrides,
  type ProviderModelMode,
  type VeniceModelDto,
} from "../../lib/tauri";
import { VIDEO_GENERATION_ENABLED } from "../../lib/feature-flags";
import { ProviderLogo } from "./ProviderLogo";
import { selectedModel } from "./ModelPickerDialog";
import {
  ModelPickerCardContent,
  ModelPickerPopover,
  type ModelPickerFlyout,
} from "./ModelPickerPopover";
import { AdminNotifications } from "./AdminNotifications";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { Dialog } from "../ui/Dialog";
import { EmptyState as EmptyStateSurface } from "../ui/EmptyState";
import { HoverTip } from "../ui/HoverTip";
import { SettingsPageHeader } from "./AppSettings";

type ProfileBuilderSectionProps = {
  /** The write-access mode whose runtime profiles are created in. Defaults to
   * the safe sandboxed runtime. */
  mode?: HermesAdminMode;
};

/**
 * June's native guided Profile Builder (spec 20). A guided wizard that creates
 * an isolated Hermes profile with a name, models, skills, and (when any are
 * configured) MCP servers, then optionally makes it active. It validates
 * the model's tool-calling capability before allowing creation, shows exactly
 * what files/config will change (with risk labels) on the review step, and
 * surfaces success/failure with rollback messaging.
 *
 * Data + orchestration live in {@link useProfileBuilder}; this component is
 * presentation. The render-only {@link ProfileBuilderView} is split out so tests
 * drive it with a stubbed state (no Tauri, no network).
 */
export function ProfileBuilderSection({ mode = "sandboxed" }: ProfileBuilderSectionProps) {
  const managerState = useProfileManager(mode);
  const builderState = useProfileBuilder(mode);
  return (
    <ProfilesSurfaceView managerState={managerState} builderState={builderState} mode={mode} />
  );
}

export function ProfilesSurfaceView({
  managerState,
  builderState,
  mode = "sandboxed",
}: {
  managerState: ProfileManagerState;
  builderState: ProfileBuilderState;
  mode?: HermesAdminMode;
}) {
  const [view, setView] = useState<"list" | "wizard">("list");

  useEffect(() => {
    if (view !== "wizard" || builderState.create.phase !== "created") return;
    if (hasCreatedFailureMessage(builderState.create)) return;
    managerState.refresh();
    builderState.reset();
    setView("list");
  }, [builderState, managerState, view]);

  if (view === "wizard") {
    return (
      <ProfileBuilderView
        state={builderState}
        mode={mode}
        onBackToProfiles={() => {
          builderState.reset();
          managerState.refresh();
          setView("list");
        }}
      />
    );
  }

  return (
    <ProfilesListView
      state={managerState}
      mode={mode}
      onNewProfile={() => {
        builderState.reset();
        setView("wizard");
      }}
    />
  );
}

function hasCreatedFailureMessage(create: ProfileBuilderState["create"]): boolean {
  if (create.phase !== "created" || !create.message || !create.createdSlug) return false;
  return create.message !== `Created "${create.createdSlug}".`;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error.";
}

export function ProfileBuilderView({
  state,
  mode = "sandboxed",
  onBackToProfiles,
}: {
  state: ProfileBuilderState;
  mode?: HermesAdminMode;
  onBackToProfiles?: () => void;
}) {
  const context = useMemo(
    () => ({ existingProfiles: state.existingProfiles, models: state.models }),
    [state.existingProfiles, state.models],
  );

  const stepValidation = useMemo(
    () => validateStep(state.step, state.form, context),
    [state.step, state.form, context],
  );

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";

  if (isUnavailable) {
    return (
      <BuilderShell mode={state.mode ?? mode} profile={state.profile} showModeNote={false}>
        <EmptyState
          title="Hermes is not running"
          description="Start Hermes to create a profile with its own models, skills, and MCP servers."
        />
      </BuilderShell>
    );
  }

  if (isErrored) {
    return (
      <BuilderShell mode={state.mode ?? mode} profile={state.profile} showModeNote={false}>
        <ErrorState
          message={state.error ?? "Could not load profiles from Hermes."}
          retryable={state.retryable}
          onRetry={state.refresh}
        />
      </BuilderShell>
    );
  }

  const created = state.create.phase === "created";

  return (
    <BuilderShell mode={state.mode ?? mode} profile={state.profile} showModeNote>
      {onBackToProfiles ? (
        <div className="profile-builder-list-back">
          <BreadcrumbBar
            backLabel="Back to profiles"
            onBack={onBackToProfiles}
            items={[{ label: "Profiles", onClick: onBackToProfiles }, { label: "Profile builder" }]}
          />
        </div>
      ) : null}
      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      {created ? (
        <CreatedPanel state={state} />
      ) : (
        <>
          <Stepper current={state.step} state={state} context={context} />
          <div className="settings-card profile-builder-card">
            <header className="profile-builder-step-header">
              <h3 className="profile-builder-step-title">{STEP_META[state.step].title}</h3>
              <p className="profile-builder-step-hint">{STEP_META[state.step].hint}</p>
            </header>

            <StepBody state={state} />

            {stepValidation.warnings.map((warning) => (
              <p key={warning} className="profile-builder-warning" role="status">
                <IconExclamationTriangle size={14} ariaHidden />
                {warning}
              </p>
            ))}
            {stepValidation.error ? (
              <p className="profile-builder-error" role="alert">
                <IconExclamationCircle size={14} ariaHidden />
                {stepValidation.error}
              </p>
            ) : null}
            {state.create.phase === "failed" && state.create.error ? (
              <p className="profile-builder-error" role="alert">
                <IconExclamationCircle size={14} ariaHidden />
                {state.create.error}
              </p>
            ) : null}

            <Footer state={state} validation={stepValidation} context={context} />
          </div>
        </>
      )}
    </BuilderShell>
  );
}

// ---------------------------------------------------------------------------
// Shell + stepper
// ---------------------------------------------------------------------------

function BuilderShell({
  mode,
  profile,
  showModeNote,
  children,
}: {
  mode: HermesAdminMode;
  profile?: string;
  showModeNote: boolean;
  children: ReactNode;
}) {
  return (
    <section className="settings-group profile-builder" aria-labelledby="profile-builder-heading">
      <SettingsPageHeader
        id="profile-builder-heading"
        title="Profiles"
        blurb={
          <>
            Create a profile with its own models, skills, and MCP servers. Every profile presents as
            June, and its notes, note transcriptions, dictation history, and chat sessions stay
            separate.{" "}
            <ModeNote
              mode={mode}
              profile={profile}
              show={showModeNote}
              prefix="New profiles target"
            />
          </>
        }
      />
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Profiles list
// ---------------------------------------------------------------------------

function ProfilesListView({
  state,
  mode,
  onNewProfile,
}: {
  state: ProfileManagerState;
  mode: HermesAdminMode;
  onNewProfile: () => void;
}) {
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasProfiles = state.profiles.length > 0;
  const onlyDefault = state.profiles.length === 1 && state.profiles[0]?.name === "default";
  const [refreshSpins, setRefreshSpins] = useState(0);

  useEffect(() => {
    const pendingName = state.pendingRemoval?.name;
    if (!pendingName) return;
    const profile = state.profiles.find((candidate) => candidate.name === pendingName);
    if (!profile) {
      state.cancelRemoval();
      return;
    }
    const guard = canRemoveProfile(pendingName, state.activeName, state.activeConfirmed);
    if (!guard.ok) {
      state.cancelRemoval();
    }
  }, [
    state.activeConfirmed,
    state.activeName,
    state.cancelRemoval,
    state.pendingRemoval,
    state.profiles,
  ]);

  const cleanupProfile = useCallback((name: string) => {
    setCleanupError(null);
    deleteProfileModelOverrides(name).catch((error: unknown) => {
      setCleanupError(
        `Deleted "${name}", but its model override cleanup failed: ${messageFromError(error)}`,
      );
    });
  }, []);

  if (isUnavailable) {
    return (
      <ProfilesShell mode={mode} profile={undefined} showModeNote={false}>
        <EmptyState
          title="Hermes is not running"
          description="Start Hermes to create a profile with its own models, skills, and MCP servers."
        />
      </ProfilesShell>
    );
  }

  return (
    <ProfilesShell mode={mode} profile={undefined} showModeNote>
      <div className="profiles-actions">
        <button
          type="button"
          className="icon-button profiles-refresh"
          aria-label="Refresh profiles"
          aria-busy={isLoadingFirst}
          disabled={isLoadingFirst}
          title="Refresh profiles"
          onClick={() => {
            setRefreshSpins((spins) => spins + 1);
            state.refresh();
          }}
        >
          <IconArrowRotateClockwise
            size={14}
            ariaHidden
            className="balance-refresh-icon"
            style={{ transform: `rotate(${refreshSpins * 360}deg)` }}
          />
        </button>
        <button type="button" className="btn btn-secondary profiles-add" onClick={onNewProfile}>
          <IconPlusMedium size={14} ariaHidden />
          New profile
        </button>
      </div>
      <div className="settings-card profiles-card">
        {(state.error || cleanupError) && hasProfiles ? (
          <p className="settings-row-error profiles-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error ?? cleanupError}
          </p>
        ) : null}

        {isErrored && !hasProfiles ? (
          <ErrorState
            message={state.error ?? "Could not load profiles from Hermes."}
            retryable
            onRetry={state.refresh}
          />
        ) : isLoadingFirst ? (
          <EmptyState
            title="Loading profiles"
            description="June is reading the profile list from Hermes."
          />
        ) : (
          <>
            <ul className="profiles-list" aria-label="Profiles">
              {state.profiles.map((profile) => (
                <ProfileRow
                  key={profile.name}
                  profile={profile}
                  activeName={state.activeName}
                  activeConfirmed={state.activeConfirmed}
                  pending={state.pendingAction}
                  pendingRemoval={state.pendingRemoval}
                  onActivate={state.activate}
                  onDelete={async (name) => {
                    const deleted = await state.beginRemove(name);
                    if (deleted) cleanupProfile(name);
                  }}
                />
              ))}
            </ul>
            {!hasProfiles || onlyDefault ? (
              <p className="profiles-empty-copy">
                Create a profile when you want a task to use its own models, skills, and MCP
                servers.
              </p>
            ) : null}
          </>
        )}
      </div>

      <ProfileDataRemovalDialog
        pendingRemoval={state.pendingRemoval}
        error={state.error}
        busy={
          state.pendingAction?.kind === "remove" &&
          state.pendingAction.name === state.pendingRemoval?.name
        }
        onCancel={state.cancelRemoval}
        onMove={async () => {
          const name = state.pendingRemoval?.name;
          if (!name) return false;
          const deleted = await state.confirmRemoval("move");
          if (deleted) cleanupProfile(name);
          return deleted;
        }}
        onDelete={async () => {
          const name = state.pendingRemoval?.name;
          if (!name) return false;
          const deleted = await state.confirmRemoval("delete");
          if (deleted) cleanupProfile(name);
          return deleted;
        }}
      />
    </ProfilesShell>
  );
}

function ProfilesShell({
  mode,
  profile,
  showModeNote,
  children,
}: {
  mode: HermesAdminMode;
  profile?: string;
  showModeNote: boolean;
  children: ReactNode;
}) {
  return (
    <section className="settings-group profile-builder" aria-labelledby="profile-builder-heading">
      <SettingsPageHeader
        id="profile-builder-heading"
        title="Profiles"
        blurb={
          <>
            Manage profiles with their own models, skills, and MCP servers. Their notes, note
            transcriptions, dictation history, and chat sessions stay separate.{" "}
            <ModeNote mode={mode} profile={profile} show={showModeNote} prefix="Showing" />
          </>
        }
      />
      {children}
    </section>
  );
}

function ModeNote({
  mode,
  profile,
  show,
  prefix,
}: {
  mode: HermesAdminMode;
  profile?: string;
  show: boolean;
  prefix: "Showing" | "New profiles target";
}) {
  if (!show) return null;
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  return (
    <span className="profile-builder-mode-note">
      {prefix} the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

function ProfileRow({
  profile,
  activeName,
  activeConfirmed,
  pending,
  pendingRemoval,
  onActivate,
  onDelete,
}: {
  profile: ProfileManagerState["profiles"][number];
  activeName: string;
  activeConfirmed: boolean;
  pending: ProfileManagerState["pendingAction"];
  pendingRemoval: ProfileManagerState["pendingRemoval"];
  onActivate: (name: string) => Promise<boolean>;
  onDelete: (name: string) => Promise<void>;
}) {
  const activateGuard = canActivateProfile(profile.name, activeName, activeConfirmed);
  const removeGuard = canRemoveProfile(profile.name, activeName, activeConfirmed);
  const isActive = profile.name === activeName;
  const pendingThisRow = pending?.name === profile.name || pendingRemoval?.name === profile.name;
  const activating = pendingThisRow && pending?.kind === "activate";
  const removing = pendingThisRow && pending?.kind === "remove";
  const description = describeProfile(profile) || "No description provided.";

  return (
    <li className="profile-row">
      <div className="profile-row-main">
        <div className="profile-row-headline">
          <span className="profile-row-name">{profile.name}</span>
          {isActive ? <span className="profile-row-active">Active</span> : null}
        </div>
        <p className="profile-row-description">{description}</p>
      </div>
      <div className="profile-row-actions">
        <button
          type="button"
          className="profile-row-activate"
          disabled={!activateGuard.ok || pendingThisRow}
          title={!activateGuard.ok ? activateGuard.reason : undefined}
          onClick={() => void onActivate(profile.name)}
        >
          {activating ? "Saving" : "Make active"}
        </button>
        <button
          type="button"
          className="profile-row-delete"
          aria-label={`Delete ${profile.name}`}
          disabled={!removeGuard.ok || pendingThisRow}
          title={!removeGuard.ok ? removeGuard.reason : "Delete profile"}
          onClick={() => void onDelete(profile.name)}
        >
          <IconTrashCan size={14} ariaHidden />
          {removing ? "Deleting" : "Delete"}
        </button>
        {!removeGuard.ok ? <span className="profile-row-hint">{removeGuard.reason}</span> : null}
      </div>
    </li>
  );
}

function ProfileDataRemovalDialog({
  pendingRemoval,
  error,
  busy,
  onCancel,
  onMove,
  onDelete,
}: {
  pendingRemoval: ProfileManagerState["pendingRemoval"];
  error?: string | null;
  busy: boolean;
  onCancel: () => void;
  onMove: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [submitting, setSubmitting] = useState<"move" | "delete" | null>(null);
  const isBusy = busy || submitting !== null;
  const name = pendingRemoval?.name;

  useEffect(() => {
    setConfirmingDelete(false);
    setSubmitting(null);
    if (!name) return;
  }, [name]);

  async function runMove() {
    if (isBusy) return;
    setSubmitting("move");
    try {
      await onMove();
    } finally {
      setSubmitting(null);
    }
  }

  async function runDelete() {
    if (isBusy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSubmitting("delete");
    try {
      await onDelete();
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Dialog
      open={Boolean(pendingRemoval)}
      onClose={() => {
        if (!isBusy) onCancel();
      }}
      title={name ? `Delete "${name}"?` : "Delete profile?"}
      description={pendingRemoval ? profileDataSummaryText(pendingRemoval.summary) : undefined}
      width={460}
      footer={
        <>
          <button type="button" className="primary-action" onClick={onCancel} disabled={isBusy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid primary-destructive"
            onClick={() => void runDelete()}
            disabled={isBusy && submitting !== "delete"}
            aria-busy={submitting === "delete" || undefined}
          >
            {submitting === "delete"
              ? "Deleting"
              : confirmingDelete
                ? "Confirm delete"
                : "Delete permanently"}
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void runMove()}
            disabled={isBusy && submitting !== "move"}
            aria-busy={submitting === "move" || undefined}
          >
            {submitting === "move" ? "Moving" : "Move to default"}
          </button>
        </>
      }
    >
      <div className="profile-data-removal-body">
        <p>Choose what to do with the data before June deletes the profile.</p>
        {confirmingDelete ? (
          <p className="profile-data-removal-warning">
            This can't be undone. Confirm delete to permanently remove this profile's data.
          </p>
        ) : null}
        {error ? (
          <p className="settings-row-error profiles-inline-error" role="alert">
            <IconExclamationCircle size={14} ariaHidden />
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function profileDataSummaryText(
  summary: NonNullable<ProfileManagerState["pendingRemoval"]>["summary"],
) {
  return `This profile has ${countLabel(summary.notes, "note")}, ${countLabel(
    summary.sessions,
    "chat",
  )}, ${countLabel(summary.dictation, "dictation")}, ${countLabel(summary.folders, "project")}.`;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function Stepper({
  current,
  state,
  context,
}: {
  current: ProfileBuilderStep;
  state: ProfileBuilderState;
  context: {
    existingProfiles: ProfileBuilderState["existingProfiles"];
    models: ProfileBuilderState["models"];
  };
}) {
  const currentIndex = state.steps.indexOf(current);
  return (
    <ol className="profile-builder-stepper" aria-label="Profile builder steps">
      {state.steps.map((step, index) => {
        const done = index < currentIndex;
        const active = step === current;
        // A step is reachable by click only when every prior step passes.
        const reachable =
          index <= currentIndex ||
          state.steps
            .slice(0, index)
            .every((prior) => validateStep(prior, state.form, context).error === undefined);
        return (
          <li
            key={step}
            className="profile-builder-stepper-item"
            data-active={active || undefined}
            data-done={done || undefined}
          >
            <button
              type="button"
              className="profile-builder-stepper-button"
              aria-current={active ? "step" : undefined}
              disabled={!reachable}
              onClick={() => state.setStep(step)}
            >
              <span className="profile-builder-stepper-index" aria-hidden>
                {done ? <IconCheckmark2Small size={13} /> : index + 1}
              </span>
              <span className="profile-builder-stepper-label">{STEP_META[step].title}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Footer({
  state,
  validation,
  context,
}: {
  state: ProfileBuilderState;
  validation: ReturnType<typeof validateStep>;
  context: {
    existingProfiles: ProfileBuilderState["existingProfiles"];
    models: ProfileBuilderState["models"];
  };
}) {
  const isFirst = state.step === "identity";
  const isReview = state.step === "review";
  const creating = state.create.phase === "creating";
  const canCreate = canCreateProfile(state.form, context);

  return (
    <div className="profile-builder-footer">
      <button
        type="button"
        className="profile-builder-back"
        disabled={isFirst || creating}
        onClick={state.goBack}
      >
        <IconArrowLeft size={14} ariaHidden />
        Back
      </button>
      {isReview ? (
        <div className="profile-builder-create-actions">
          <button
            type="button"
            className="profile-builder-create profile-builder-create-secondary"
            disabled={!canCreate || creating}
            onClick={() => state.createProfile()}
          >
            {creating ? (state.create.message ?? "Creating...") : "Create profile"}
          </button>
          <button
            type="button"
            className="profile-builder-create"
            disabled={!canCreate || creating}
            onClick={() => state.createProfile({ makeActive: true })}
          >
            {creating ? (state.create.message ?? "Creating...") : "Create and make active"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="profile-builder-next"
          disabled={validation.error !== undefined}
          onClick={state.goNext}
        >
          Next
          <IconArrowRight size={14} ariaHidden />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step bodies
// ---------------------------------------------------------------------------

function StepBody({ state }: { state: ProfileBuilderState }) {
  switch (state.step) {
    case "identity":
      return <BasicsStep state={state} />;
    case "model":
      return <ModelStep state={state} />;
    case "skills":
      return <SkillsStep state={state} />;
    case "mcps":
      return <McpStep state={state} />;
    case "review":
      return <ReviewStep state={state} />;
  }
}

function BasicsStep({ state }: { state: ProfileBuilderState }) {
  const { form } = state;
  const slug = slugifyProfileName(form.name);
  const nameError = validateProfileName(form.name, state.existingProfiles);
  return (
    <div className="profile-builder-fields">
      <label className="profile-builder-field">
        <span className="profile-builder-field-label">Profile name</span>
        <input
          type="text"
          value={form.name}
          placeholder="Research assistant"
          aria-label="Profile name"
          aria-invalid={Boolean(form.name && nameError) || undefined}
          onChange={(event) => state.update({ name: event.currentTarget.value })}
        />
        {slug ? <span className="profile-builder-field-meta">Slug: {slug}</span> : null}
      </label>

      <label className="profile-builder-field">
        <span className="profile-builder-field-label">Description</span>
        <input
          type="text"
          value={form.description}
          placeholder="What this profile is for"
          aria-label="Description"
          onChange={(event) => state.update({ description: event.currentTarget.value })}
        />
      </label>
    </div>
  );
}

function ModelStep({ state }: { state: ProfileBuilderState }) {
  const { form, models } = state;
  const support = selectedModelToolSupport(form, models);
  const [pickerMode, setPickerMode] = useState<ProviderModelMode>();
  const [modelPickerFlyout, setModelPickerFlyout] = useState<ModelPickerFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const modelPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPickerPopoverRef = useRef<HTMLDivElement>(null);
  const modelPickerSearchRef = useRef<HTMLInputElement>(null);
  const textOptions = useMemo(() => models.map(profileModelToVeniceModel), [models]);

  const closeModelPicker = useCallback(() => {
    setPickerMode(undefined);
    setModelPickerFlyout(null);
    setModelSearch("");
  }, []);

  function openModelPicker(mode: ProviderModelMode) {
    setPickerMode(mode);
    setModelPickerFlyout(null);
    setModelSearch("");
  }

  function modelOptionsForMode(mode: ProviderModelMode): VeniceModelDto[] {
    if (mode === "transcription") return [...state.voiceModels];
    if (mode === "image") return [...state.imageModels];
    if (mode === "video") return [...state.videoModels];
    return textOptions;
  }

  function selectModelFromPicker(mode: ProviderModelMode, modelId: string) {
    const picked = modelOptionsForMode(mode).find((model) => model.id === modelId);
    if (mode === "generation") {
      state.update({ provider: picked?.provider ?? "venice", model: modelId });
    } else if (mode === "transcription") {
      state.update({ voiceProvider: picked?.provider ?? "venice", voiceModel: modelId });
    } else if (mode === "image") {
      state.update({ imageModel: modelId });
    } else {
      state.update({ videoModel: modelId });
    }
    closeModelPicker();
  }

  useEffect(() => {
    if (!pickerMode) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (modelPickerPopoverRef.current?.contains(target)) return;
      if (modelPickerTriggerRef.current?.contains(target)) return;
      closeModelPicker();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (modelPickerFlyout?.kind === "all") {
        setModelPickerFlyout(null);
        setModelSearch("");
      } else {
        closeModelPicker();
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerMode, modelPickerFlyout, closeModelPicker]);

  return (
    <div className="profile-builder-fields profile-builder-model-slots">
      {models.length === 0 ? (
        <p className="profile-builder-field-meta">
          No models were reported. Check your provider key in the Models tab.
        </p>
      ) : (
        <>
          <ProfileModelRow
            mode="generation"
            title="Text"
            description="The agent model for this profile. It must support tool calling."
            value={form.model}
            options={textOptions}
            open={pickerMode === "generation"}
            flyout={modelPickerFlyout}
            search={modelSearch}
            triggerRef={modelPickerTriggerRef}
            popoverRef={modelPickerPopoverRef}
            searchRef={modelPickerSearchRef}
            onToggle={() =>
              pickerMode === "generation" ? closeModelPicker() : openModelPicker("generation")
            }
            onFlyoutChange={setModelPickerFlyout}
            onSearchChange={setModelSearch}
            onSelect={(modelId) => selectModelFromPicker("generation", modelId)}
          />
          <ProfileModelRow
            mode="transcription"
            title="Voice"
            description="Speech-to-text for this profile. Leave it on June's default unless this profile needs its own choice."
            value={form.voiceModel || state.effectiveModelSettings?.transcriptionModel || ""}
            options={state.voiceModels}
            open={pickerMode === "transcription"}
            flyout={modelPickerFlyout}
            search={modelSearch}
            triggerRef={modelPickerTriggerRef}
            popoverRef={modelPickerPopoverRef}
            searchRef={modelPickerSearchRef}
            defaulted={!form.voiceModel}
            onReset={() => state.update({ voiceProvider: "", voiceModel: "" })}
            onToggle={() =>
              pickerMode === "transcription" ? closeModelPicker() : openModelPicker("transcription")
            }
            onFlyoutChange={setModelPickerFlyout}
            onSearchChange={setModelSearch}
            onSelect={(modelId) => selectModelFromPicker("transcription", modelId)}
          />
          <ProfileModelRow
            mode="image"
            title="Image"
            description="Image generation for this profile. Leave it on June's default unless this profile needs its own choice."
            value={form.imageModel || state.effectiveModelSettings?.imageModel || ""}
            options={state.imageModels}
            open={pickerMode === "image"}
            flyout={modelPickerFlyout}
            search={modelSearch}
            triggerRef={modelPickerTriggerRef}
            popoverRef={modelPickerPopoverRef}
            searchRef={modelPickerSearchRef}
            defaulted={!form.imageModel}
            onReset={() => state.update({ imageModel: "" })}
            onToggle={() =>
              pickerMode === "image" ? closeModelPicker() : openModelPicker("image")
            }
            onFlyoutChange={setModelPickerFlyout}
            onSearchChange={setModelSearch}
            onSelect={(modelId) => selectModelFromPicker("image", modelId)}
          />
          {VIDEO_GENERATION_ENABLED ? (
            <ProfileModelRow
              mode="video"
              title="Video"
              description="Video generation for this profile. Leave it on June's default unless this profile needs its own choice."
              value={form.videoModel || state.effectiveModelSettings?.videoModel || ""}
              options={state.videoModels}
              open={pickerMode === "video"}
              flyout={modelPickerFlyout}
              search={modelSearch}
              triggerRef={modelPickerTriggerRef}
              popoverRef={modelPickerPopoverRef}
              searchRef={modelPickerSearchRef}
              defaulted={!form.videoModel}
              onReset={() => state.update({ videoModel: "" })}
              onToggle={() =>
                pickerMode === "video" ? closeModelPicker() : openModelPicker("video")
              }
              onFlyoutChange={setModelPickerFlyout}
              onSearchChange={setModelSearch}
              onSelect={(modelId) => selectModelFromPicker("video", modelId)}
            />
          ) : null}
        </>
      )}
      {support && !support.supportsTools ? (
        <p className="profile-builder-field-meta">
          Provider: {support.model.provider}. June needs tool calling, so this model cannot be used
          for an agent profile.
        </p>
      ) : null}
    </div>
  );
}

function ProfileModelRow({
  mode,
  title,
  description,
  value,
  options,
  open,
  flyout,
  search,
  triggerRef,
  popoverRef,
  searchRef,
  defaulted,
  onReset,
  onToggle,
  onFlyoutChange,
  onSearchChange,
  onSelect,
}: {
  mode: ProviderModelMode;
  title: string;
  description: string;
  value: string;
  options: readonly VeniceModelDto[];
  open: boolean;
  flyout: ModelPickerFlyout;
  search: string;
  triggerRef: RefObject<HTMLButtonElement>;
  popoverRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  defaulted?: boolean;
  onReset?: () => void;
  onToggle: () => void;
  onFlyoutChange: (flyout: ModelPickerFlyout) => void;
  onSearchChange: (value: string) => void;
  onSelect: (modelId: string) => void;
}) {
  const model = selectedModel([...options], value);
  const modelLabel = `${title.toLowerCase()} model`;
  return (
    <div className="settings-row settings-model-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
        {defaulted ? (
          <p className="settings-row-description settings-row-substatus">June's default</p>
        ) : null}
      </div>
      <div className="settings-row-control settings-model-control profile-builder-model-control">
        <HoverTip
          tip={<ModelSummaryHoverDetails model={model} />}
          className="model-summary-tip-anchor"
          width={280}
          delay={280}
          suppressed={open}
        >
          <button
            ref={open ? triggerRef : undefined}
            type="button"
            className="model-summary-button"
            onClick={onToggle}
            aria-label={`Change ${modelLabel}`}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <span className="model-summary-logo" aria-hidden>
              <ProviderLogo provider={model.provider} id={model.id} name={model.name} />
            </span>
            <span className="model-summary-name">{model.name || "Choose model"}</span>
            <IconChevronDownSmall size={14} aria-hidden />
          </button>
        </HoverTip>
        {!defaulted && onReset ? (
          <button
            type="button"
            className="profile-builder-model-reset"
            onClick={onReset}
            aria-label={`Reset ${modelLabel} to June's default`}
          >
            Reset
          </button>
        ) : null}
        {open ? (
          <ModelPickerPopover
            mode={mode}
            flyout={flyout}
            model={model}
            options={[...options]}
            search={search}
            popoverRef={popoverRef}
            searchRef={searchRef}
            className="settings-model-popover"
            title={modelLabel[0].toUpperCase() + modelLabel.slice(1)}
            ariaLabel={`Choose ${modelLabel}`}
            onFlyoutChange={onFlyoutChange}
            onSearchChange={onSearchChange}
            onSelect={onSelect}
          />
        ) : null}
      </div>
    </div>
  );
}

function ModelSummaryHoverDetails({ model }: { model: VeniceModelDto }) {
  return (
    <span className="agent-composer-model-detail model-summary-hovercard">
      <ModelPickerCardContent model={model} withDescription />
    </span>
  );
}

function profileModelToVeniceModel(model: ProfileBuilderState["models"][number]): VeniceModelDto {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    modelType: "generation",
    traits: [],
    capabilities: [...model.capabilities],
  };
}

function SkillsStep({ state }: { state: ProfileBuilderState }) {
  const { form } = state;
  const bundled = bundledSkillOptions(state.skills);
  return (
    <div className="profile-builder-fields">
      <label className="profile-builder-checkbox">
        <input
          type="checkbox"
          checked={form.keepBundledSkills}
          onChange={(event) => state.update({ keepBundledSkills: event.currentTarget.checked })}
        />
        <span>
          Keep June's bundled skills
          <span className="profile-builder-field-meta">
            Copies the default profile's skills into this one.
          </span>
        </span>
      </label>

      {form.keepBundledSkills && bundled.length > 0 ? (
        <div className="profile-builder-skill-list" role="group" aria-label="Bundled skills">
          {bundled.map((skill) => {
            const keptAll = form.keepSkills.length === 0;
            const checked = keptAll || form.keepSkills.includes(skill.name);
            return (
              <label key={skill.name} className="profile-builder-checkbox">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    // Empty keepSkills means "keep all"; the first narrowing
                    // materializes the full set minus/plus this one.
                    const base = keptAll ? bundled.map((s) => s.name) : form.keepSkills;
                    const next = event.currentTarget.checked
                      ? Array.from(new Set([...base, skill.name]))
                      : base.filter((name) => name !== skill.name);
                    state.update({ keepSkills: next });
                  }}
                />
                <span>{skill.name}</span>
              </label>
            );
          })}
        </div>
      ) : null}

      <p className="profile-builder-field-meta">
        Hub skills can be installed from the Skills hub after the profile is created.
      </p>
    </div>
  );
}

function McpStep({ state }: { state: ProfileBuilderState }) {
  const { form } = state;
  const attachableServers = useMemo(
    () => attachableMcpServers(state.mcpServers),
    [state.mcpServers],
  );
  return (
    <div className="profile-builder-fields">
      <span className="profile-builder-field-label">Attach MCP servers</span>
      <p className="profile-builder-field-meta">June's built-in tools are always included.</p>
      {attachableServers.length === 0 ? (
        <p className="profile-builder-field-meta">
          No MCP servers configured yet. Add servers from the MCP servers tab.
        </p>
      ) : (
        <div className="profile-builder-mcp-list" role="group" aria-label="MCP servers">
          {attachableServers.map((server) => {
            const checked = form.mcpServers.includes(server.name);
            return (
              <label key={server.name} className="profile-builder-checkbox">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = event.currentTarget.checked
                      ? [...form.mcpServers, server.name]
                      : form.mcpServers.filter((name) => name !== server.name);
                    state.update({ mcpServers: next });
                  }}
                />
                <span>{server.name}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewStep({ state }: { state: ProfileBuilderState }) {
  const plan = useMemo(
    () =>
      buildCreatePlan(state.form, {
        generation: state.models,
        transcription: state.voiceModels,
        image: state.imageModels,
        video: state.videoModels,
      }),
    [state.form, state.models, state.voiceModels, state.imageModels, state.videoModels],
  );
  return (
    <div className="profile-builder-review">
      <p className="profile-builder-field-meta">
        Creating this profile makes these changes. Nothing runs until you start a session under it.
      </p>
      <ul className="profile-builder-plan" aria-label="Planned changes">
        {plan.map((change) => (
          <li
            key={`${change.target}-${change.detail}`}
            className="profile-builder-plan-row"
            data-risk={change.risk}
          >
            <RiskBadge risk={change.risk} />
            <div className="profile-builder-plan-text">
              <code className="profile-builder-plan-target">{change.target}</code>
              <span className="profile-builder-plan-detail">{change.detail}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RiskBadge({ risk }: { risk: ChangeRisk }) {
  const label = risk === "caution" ? "Review" : "Safe";
  const tone = risk === "caution" ? "warning" : "info";
  return (
    <span className="profile-builder-risk" data-tone={tone}>
      {label}
    </span>
  );
}

function CreatedPanel({ state }: { state: ProfileBuilderState }) {
  const slug = state.create.createdSlug ?? "the profile";
  return (
    <div className="settings-card profile-builder-card profile-builder-created">
      <span className="profile-builder-created-icon" aria-hidden>
        <IconRobot2 size={26} />
      </span>
      <h3 className="profile-builder-created-title">Profile created</h3>
      <p className="profile-builder-created-detail">
        {state.create.message ?? `Created "${slug}".`}{" "}
        {state.create.activated
          ? "It is now active for new sessions."
          : "Start a session under it to use it."}
      </p>
      <button type="button" className="profile-builder-create" onClick={state.reset}>
        Create another profile
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared empty/error states
// ---------------------------------------------------------------------------

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <EmptyStateSurface
      className="empty-state-compact"
      icon={<IconRobot2 size={22} />}
      title={title}
      description={description}
    />
  );
}

function ErrorState({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="settings-card profile-builder-empty" role="alert">
      <span className="profile-builder-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="profile-builder-empty-title">Couldn't load profiles</p>
      <p className="profile-builder-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="profile-builder-create" onClick={onRetry}>
          <IconArrowRotateClockwise size={14} ariaHidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}
