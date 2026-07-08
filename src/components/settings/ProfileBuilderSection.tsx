import { IconArrowLeft } from "central-icons/IconArrowLeft";
import { IconArrowRight } from "central-icons/IconArrowRight";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconRobot2 } from "central-icons/IconRobot2";
import { IconShield } from "central-icons/IconShield";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PROFILE_BUILDER_STEPS,
  STEP_META,
  buildCreatePlan,
  bundledSkillOptions,
  canActivateProfile,
  canCreateProfile,
  canRemoveProfile,
  describeProfile,
  installableCatalogEntries,
  selectedModelToolSupport,
  slugifyProfileName,
  stepIndex,
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
import { ProviderLogo } from "./ProviderLogo";
import { AdminNotifications } from "./AdminNotifications";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState as EmptyStateSurface } from "../ui/EmptyState";
import { SettingsPageHeader } from "./AppSettings";

type ProfileBuilderSectionProps = {
  /** The write-access mode whose runtime profiles are created in. Defaults to
   * the safe sandboxed runtime. */
  mode?: HermesAdminMode;
};

/**
 * June's native guided Profile Builder (spec 20). A six-step wizard that creates
 * an isolated Hermes profile with identity/SOUL, model/provider, sandbox policy,
 * skills, and MCP servers, then optionally starts a test session. It validates
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
          description="Start Hermes to create a profile. A profile gives a task its own model, skills, MCP servers, and instructions."
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
            Create a specialized profile with its own model, skills, MCP servers, and instructions.
            A profile keeps June's identity unless you give it its own.{" "}
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
  const [toDelete, setToDelete] = useState<string | undefined>();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasProfiles = state.profiles.length > 0;
  const onlyDefault = state.profiles.length === 1 && state.profiles[0]?.name === "default";
  const [refreshSpins, setRefreshSpins] = useState(0);

  useEffect(() => {
    if (!toDelete) return;
    const profile = state.profiles.find((candidate) => candidate.name === toDelete);
    if (!profile) {
      setToDelete(undefined);
      setDeleteError(null);
      return;
    }
    const guard = canRemoveProfile(toDelete, state.activeName, state.activeConfirmed);
    if (!guard.ok) {
      setToDelete(undefined);
      setDeleteError(null);
    }
  }, [state.activeConfirmed, state.activeName, state.profiles, toDelete]);

  useEffect(() => {
    if (toDelete && state.error) setDeleteError(state.error);
  }, [state.error, toDelete]);

  if (isUnavailable) {
    return (
      <ProfilesShell mode={mode} profile={undefined} showModeNote={false}>
        <EmptyState
          title="Hermes is not running"
          description="Start Hermes to create a profile. A profile gives a task its own model, skills, MCP servers, and instructions."
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
        {state.error && hasProfiles ? (
          <p className="settings-row-error profiles-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
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
                  onActivate={state.activate}
                  onDelete={(name) => {
                    setDeleteError(null);
                    setToDelete(name);
                  }}
                />
              ))}
            </ul>
            {!hasProfiles || onlyDefault ? (
              <p className="profiles-empty-copy">
                Create a profile when you want a task to use its own model, skills, MCP servers, or
                instructions.
              </p>
            ) : null}
          </>
        )}
      </div>

      <DeleteProfileDialog
        name={toDelete}
        error={deleteError}
        onClose={() => {
          setToDelete(undefined);
          setDeleteError(null);
        }}
        onConfirm={async () => {
          if (!toDelete) throw new Error("No profile selected.");
          const profile = state.profiles.find((candidate) => candidate.name === toDelete);
          const guard = canRemoveProfile(toDelete, state.activeName, state.activeConfirmed);
          if (!profile || !guard.ok) {
            setDeleteError(guard.ok ? "That profile is no longer available." : guard.reason);
            throw new Error("Profile removal is no longer available.");
          }
          const removed = await state.remove(toDelete);
          if (!removed) {
            setDeleteError(state.error ?? "Could not delete the profile. Refresh and try again.");
            throw new Error("Profile removal failed.");
          }
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
            Manage profiles with their own model, skills, MCP servers, and instructions.{" "}
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
  onActivate,
  onDelete,
}: {
  profile: ProfileManagerState["profiles"][number];
  activeName: string;
  activeConfirmed: boolean;
  pending: ProfileManagerState["pendingAction"];
  onActivate: (name: string) => Promise<boolean>;
  onDelete: (name: string) => void;
}) {
  const activateGuard = canActivateProfile(profile.name, activeName, activeConfirmed);
  const removeGuard = canRemoveProfile(profile.name, activeName, activeConfirmed);
  const isActive = profile.name === activeName;
  const pendingThisRow = pending?.name === profile.name;
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
          onClick={() => onDelete(profile.name)}
        >
          <IconTrashCan size={14} ariaHidden />
          {removing ? "Deleting" : "Delete"}
        </button>
        {!removeGuard.ok ? <span className="profile-row-hint">{removeGuard.reason}</span> : null}
      </div>
    </li>
  );
}

function DeleteProfileDialog({
  name,
  error,
  onClose,
  onConfirm,
}: {
  name?: string;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const description = name
    ? `Remove ${name}? New sessions will no longer load it. This cannot be undone.`
    : undefined;
  return (
    <ConfirmDialog
      open={Boolean(name)}
      onClose={onClose}
      onConfirm={onConfirm}
      title={name ? `Delete "${name}"?` : "Delete profile?"}
      description={
        description ? (
          <>
            <span>{description}</span>
            {error ? (
              <span className="settings-row-error profiles-inline-error" role="alert">
                <IconExclamationCircle size={14} ariaHidden />
                {error}
              </span>
            ) : null}
          </>
        ) : undefined
      }
      confirmLabel="Delete profile"
      confirmBusyLabel="Deleting"
      destructive
    />
  );
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
  const currentIndex = stepIndex(current);
  return (
    <ol className="profile-builder-stepper" aria-label="Profile builder steps">
      {PROFILE_BUILDER_STEPS.map((step, index) => {
        const done = index < currentIndex;
        const active = step === current;
        // A step is reachable by click only when every prior step passes.
        const reachable =
          index <= currentIndex ||
          PROFILE_BUILDER_STEPS.slice(0, index).every(
            (prior) => validateStep(prior, state.form, context).error === undefined,
          );
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
            onClick={() => state.createProfile({ startTestSession: true })}
          >
            {creating ? (state.create.message ?? "Creating...") : "Create and start test session"}
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
      return <IdentityStep state={state} />;
    case "model":
      return <ModelStep state={state} />;
    case "toolsets":
      return <ToolsetsStep state={state} />;
    case "skills":
      return <SkillsStep state={state} />;
    case "mcps":
      return <McpStep state={state} />;
    case "review":
      return <ReviewStep state={state} />;
  }
}

function IdentityStep({ state }: { state: ProfileBuilderState }) {
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

      <fieldset className="profile-builder-fieldset">
        <legend className="profile-builder-field-label">Identity</legend>
        <label className="profile-builder-radio">
          <input
            type="radio"
            name="identity"
            checked={form.identity === "june-default"}
            onChange={() => state.update({ identity: "june-default" })}
          />
          <span>
            <span className="profile-builder-radio-title">June (default)</span>
            <span className="profile-builder-radio-detail">
              Specializes June for this task. The agent still identifies as June.
            </span>
          </span>
        </label>
        <label className="profile-builder-radio">
          <input
            type="radio"
            name="identity"
            checked={form.identity === "specialized"}
            onChange={() => state.update({ identity: "specialized" })}
          />
          <span>
            <span className="profile-builder-radio-title">Specialized role</span>
            <span className="profile-builder-radio-detail">
              A distinct named agent. Give it its own instructions below.
            </span>
          </span>
        </label>
      </fieldset>

      <label className="profile-builder-field">
        <span className="profile-builder-field-label">Custom instructions (SOUL)</span>
        <textarea
          value={form.soul}
          rows={4}
          placeholder="Optional. Leave empty to keep June's instructions."
          aria-label="Custom instructions"
          onChange={(event) => state.update({ soul: event.currentTarget.value })}
        />
      </label>
    </div>
  );
}

function ModelStep({ state }: { state: ProfileBuilderState }) {
  const { form, models } = state;
  const support = selectedModelToolSupport(form, models);
  return (
    <div className="profile-builder-fields">
      {models.length === 0 ? (
        <p className="profile-builder-field-meta">
          No models were reported. Check your provider key in the Models tab.
        </p>
      ) : (
        <ul className="profile-builder-model-list" aria-label="Generation models">
          {models.map((model) => {
            const selected = model.id === form.model && model.provider === form.provider;
            const supportsTools = model.capabilities.some((capability) => {
              const normalized = capability.toLowerCase().replace(/[^a-z]/g, "");
              return normalized.includes("functioncalling") || normalized.includes("toolcalling");
            });
            return (
              <li key={`${model.provider}:${model.id}`}>
                <button
                  type="button"
                  className="profile-builder-model-row"
                  data-selected={selected || undefined}
                  aria-pressed={selected}
                  onClick={() => state.update({ provider: model.provider, model: model.id })}
                >
                  <ProviderLogo
                    provider={model.provider}
                    id={model.id}
                    name={model.name}
                    size={18}
                  />
                  <span className="profile-builder-model-name">{model.name}</span>
                  {supportsTools ? (
                    <span
                      className="profile-builder-model-tag"
                      data-tone="info"
                      title="Supports tool calling"
                    >
                      Tools
                    </span>
                  ) : (
                    <span
                      className="profile-builder-model-tag"
                      data-tone="destructive"
                      title="No tool calling"
                    >
                      No tools
                    </span>
                  )}
                  {selected ? <IconCheckmark2Small size={15} ariaHidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
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

function ToolsetsStep({ state }: { state: ProfileBuilderState }) {
  const { form } = state;
  return (
    <fieldset className="profile-builder-fieldset">
      <legend className="profile-builder-field-label">Sandbox policy</legend>
      <label className="profile-builder-radio">
        <input
          type="radio"
          name="sandbox"
          checked={form.sandbox === "sandboxed"}
          onChange={() => state.update({ sandbox: "sandboxed" })}
        />
        <span>
          <span className="profile-builder-radio-title">
            <IconShield size={13} ariaHidden /> Sandboxed (default)
          </span>
          <span className="profile-builder-radio-detail">
            Local subprocesses, scripts, and external directories stay jailed. The safe default for
            most profiles.
          </span>
        </span>
      </label>
      <label className="profile-builder-radio">
        <input
          type="radio"
          name="sandbox"
          checked={form.sandbox === "unrestricted"}
          onChange={() => state.update({ sandbox: "unrestricted" })}
        />
        <span>
          <span className="profile-builder-radio-title">Full mode</span>
          <span className="profile-builder-radio-detail">
            No sandbox. Use only for trusted work that needs broad local access.
          </span>
        </span>
      </label>
    </fieldset>
  );
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
        <div className="profile-builder-skill-list" aria-label="Bundled skills">
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
  const installable = installableCatalogEntries(state.mcpCatalog);
  return (
    <div className="profile-builder-fields">
      <span className="profile-builder-field-label">Attach MCP servers</span>
      {state.mcpServers.length === 0 ? (
        <p className="profile-builder-field-meta">
          No MCP servers configured yet. Add servers from the MCP servers tab.
        </p>
      ) : (
        <div className="profile-builder-mcp-list" aria-label="MCP servers">
          {state.mcpServers.map((server) => {
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

      {installable.length > 0 ? (
        <>
          <span className="profile-builder-field-label">Install from catalog</span>
          <div className="profile-builder-mcp-list" aria-label="MCP catalog">
            {installable.map((entry) => {
              const checked = form.mcpCatalogInstalls.includes(entry.installName);
              return (
                <label key={entry.installName} className="profile-builder-checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const next = event.currentTarget.checked
                        ? [...form.mcpCatalogInstalls, entry.installName]
                        : form.mcpCatalogInstalls.filter((name) => name !== entry.installName);
                      state.update({ mcpCatalogInstalls: next });
                    }}
                  />
                  <span>{entry.name}</span>
                </label>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ReviewStep({ state }: { state: ProfileBuilderState }) {
  const plan = useMemo(() => buildCreatePlan(state.form), [state.form]);
  return (
    <div className="profile-builder-review">
      <p className="profile-builder-field-meta">
        Creating this profile makes these changes. Nothing runs until you start a session under it.
      </p>
      <ul className="profile-builder-plan" aria-label="Planned changes">
        {plan.map((change, index) => (
          <li
            key={`${change.target}-${index}`}
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
  const label = risk === "danger" ? "High" : risk === "caution" ? "Review" : "Safe";
  const tone = risk === "danger" ? "destructive" : risk === "caution" ? "warning" : "info";
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
        {state.create.testSessionStarted
          ? "A test session is running under it."
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
