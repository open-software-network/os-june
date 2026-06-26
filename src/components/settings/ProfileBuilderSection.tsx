import { IconArrowLeft } from "central-icons/IconArrowLeft";
import { IconArrowRight } from "central-icons/IconArrowRight";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconRobot2 } from "central-icons/IconRobot2";
import { IconShield } from "central-icons/IconShield";
import { useMemo, type ReactNode } from "react";
import {
  PROFILE_BUILDER_STEPS,
  STEP_META,
  buildCreatePlan,
  bundledSkillOptions,
  canCreateProfile,
  installableCatalogEntries,
  selectedModelToolSupport,
  slugifyProfileName,
  stepIndex,
  useProfileBuilder,
  validateProfileName,
  validateStep,
  type ChangeRisk,
  type HermesAdminMode,
  type ProfileBuilderState,
  type ProfileBuilderStep,
} from "../../lib/hermes-admin";
import { ProviderLogo } from "./ProviderLogo";
import { AdminNotifications } from "./AdminNotifications";

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
export function ProfileBuilderSection({
  mode = "sandboxed",
}: ProfileBuilderSectionProps) {
  const state = useProfileBuilder(mode);
  return <ProfileBuilderView state={state} mode={mode} />;
}

export function ProfileBuilderView({
  state,
  mode = "sandboxed",
}: {
  state: ProfileBuilderState;
  mode?: HermesAdminMode;
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
      <BuilderShell
        mode={state.mode ?? mode}
        profile={state.profile}
        show={false}
      >
        <EmptyState
          title="Hermes is not running"
          description="Start Hermes to create a profile. A profile gives a task its own model, skills, MCP servers, and instructions."
        />
      </BuilderShell>
    );
  }

  if (isErrored) {
    return (
      <BuilderShell
        mode={state.mode ?? mode}
        profile={state.profile}
        show={false}
      >
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
    <BuilderShell mode={state.mode ?? mode} profile={state.profile} show>
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
              <h3 className="profile-builder-step-title">
                {STEP_META[state.step].title}
              </h3>
              <p className="profile-builder-step-hint">
                {STEP_META[state.step].hint}
              </p>
            </header>

            <StepBody state={state} />

            {stepValidation.warnings.map((warning) => (
              <p
                key={warning}
                className="profile-builder-warning"
                role="status"
              >
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

            <Footer
              state={state}
              validation={stepValidation}
              context={context}
            />
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
  show,
  children,
}: {
  mode: HermesAdminMode;
  profile?: string;
  show: boolean;
  children: ReactNode;
}) {
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  return (
    <section
      className="settings-group profile-builder"
      aria-labelledby="profile-builder-heading"
    >
      <h2 id="profile-builder-heading" className="settings-group-heading">
        Profile builder
      </h2>
      <p className="settings-group-description">
        Create a specialized profile with its own model, skills, MCP servers,
        and instructions. A profile keeps June's identity unless you give it its
        own.{" "}
        {show ? (
          <span className="profile-builder-mode-note">
            New profiles target the {modeLabel} runtime
            {profile ? ` (profile ${profile})` : ""}.
          </span>
        ) : null}
      </p>
      {children}
    </section>
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
            (prior) =>
              validateStep(prior, state.form, context).error === undefined,
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
              <span className="profile-builder-stepper-label">
                {STEP_META[step].title}
              </span>
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
            {creating
              ? (state.create.message ?? "Creating...")
              : "Create profile"}
          </button>
          <button
            type="button"
            className="profile-builder-create"
            disabled={!canCreate || creating}
            onClick={() => state.createProfile({ startTestSession: true })}
          >
            {creating
              ? (state.create.message ?? "Creating...")
              : "Create and start test session"}
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
          onChange={(event) =>
            state.update({ name: event.currentTarget.value })
          }
        />
        {slug ? (
          <span className="profile-builder-field-meta">Slug: {slug}</span>
        ) : null}
      </label>

      <label className="profile-builder-field">
        <span className="profile-builder-field-label">Description</span>
        <input
          type="text"
          value={form.description}
          placeholder="What this profile is for"
          aria-label="Description"
          onChange={(event) =>
            state.update({ description: event.currentTarget.value })
          }
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
              Specializes June for this task. The agent still identifies as
              June.
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
            <span className="profile-builder-radio-title">
              Specialized role
            </span>
            <span className="profile-builder-radio-detail">
              A distinct named agent. Give it its own instructions below.
            </span>
          </span>
        </label>
      </fieldset>

      <label className="profile-builder-field">
        <span className="profile-builder-field-label">
          Custom instructions (SOUL)
        </span>
        <textarea
          value={form.soul}
          rows={4}
          placeholder="Optional. Leave empty to keep June's instructions."
          aria-label="Custom instructions"
          onChange={(event) =>
            state.update({ soul: event.currentTarget.value })
          }
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
        <ul
          className="profile-builder-model-list"
          aria-label="Generation models"
        >
          {models.map((model) => {
            const selected =
              model.id === form.model && model.provider === form.provider;
            const supportsTools = model.capabilities.some((capability) => {
              const normalized = capability
                .toLowerCase()
                .replace(/[^a-z]/g, "");
              return (
                normalized.includes("functioncalling") ||
                normalized.includes("toolcalling")
              );
            });
            return (
              <li key={`${model.provider}:${model.id}`}>
                <button
                  type="button"
                  className="profile-builder-model-row"
                  data-selected={selected || undefined}
                  aria-pressed={selected}
                  onClick={() =>
                    state.update({ provider: model.provider, model: model.id })
                  }
                >
                  <ProviderLogo
                    provider={model.provider}
                    id={model.id}
                    name={model.name}
                    size={18}
                  />
                  <span className="profile-builder-model-name">
                    {model.name}
                  </span>
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
                  {selected ? (
                    <IconCheckmark2Small size={15} ariaHidden />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {support && !support.supportsTools ? (
        <p className="profile-builder-field-meta">
          Provider: {support.model.provider}. June needs tool calling, so this
          model cannot be used for an agent profile.
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
            Local subprocesses, scripts, and external directories stay jailed.
            The safe default for most profiles.
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
          onChange={(event) =>
            state.update({ keepBundledSkills: event.currentTarget.checked })
          }
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
                    const base = keptAll
                      ? bundled.map((s) => s.name)
                      : form.keepSkills;
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
        Hub skills can be installed from the Skills hub after the profile is
        created.
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
          <span className="profile-builder-field-label">
            Install from catalog
          </span>
          <div className="profile-builder-mcp-list" aria-label="MCP catalog">
            {installable.map((entry) => {
              const checked = form.mcpCatalogInstalls.includes(
                entry.installName,
              );
              return (
                <label
                  key={entry.installName}
                  className="profile-builder-checkbox"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const next = event.currentTarget.checked
                        ? [...form.mcpCatalogInstalls, entry.installName]
                        : form.mcpCatalogInstalls.filter(
                            (name) => name !== entry.installName,
                          );
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
        Creating this profile makes these changes. Nothing runs until you start
        a session under it.
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
              <code className="profile-builder-plan-target">
                {change.target}
              </code>
              <span className="profile-builder-plan-detail">
                {change.detail}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RiskBadge({ risk }: { risk: ChangeRisk }) {
  const label =
    risk === "danger" ? "High" : risk === "caution" ? "Review" : "Safe";
  const tone =
    risk === "danger" ? "destructive" : risk === "caution" ? "warning" : "info";
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
      <button
        type="button"
        className="profile-builder-create"
        onClick={state.reset}
      >
        Create another profile
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared empty/error states
// ---------------------------------------------------------------------------

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="settings-card profile-builder-empty" role="status">
      <span className="profile-builder-empty-icon" aria-hidden>
        <IconRobot2 size={22} />
      </span>
      <p className="profile-builder-empty-title">{title}</p>
      <p className="profile-builder-empty-description">{description}</p>
    </div>
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
        <button
          type="button"
          className="profile-builder-create"
          onClick={onRetry}
        >
          <IconArrowRotateClockwise size={14} ariaHidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}
