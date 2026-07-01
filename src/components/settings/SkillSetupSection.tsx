import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import { IconEyeSlash } from "central-icons/IconEyeSlash";
import { IconLock } from "central-icons/IconLock";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useEffect, useId, useRef, useState } from "react";
import {
  timingLabel,
  useSkillSetup,
  validateConfigValue,
  type HermesAdminMode,
  type SkillConfigSetupRow,
  type SkillEnvSetupRow,
  type SkillSetupBadge as SkillSetupBadgeModel,
  type SkillSetupState,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";

/**
 * The skill config and required-secret setup surface (spec 09). For one skill it
 * shows the required env vars (secrets) and non-secret config settings the skill
 * declares, lets the user set/update/clear them through the foundation client,
 * and states the honest apply timing (a secret needs a gateway restart; config
 * applies next session). It is reached from the Installed skills list as a
 * per-skill expandable panel.
 *
 * SECRET SAFETY: an existing secret value is NEVER shown unless the user
 * explicitly reveals it; the reveal is a one-time read into a field that is
 * cleared on collapse. A draft secret is held only in the local input and is
 * sent straight to Hermes on save, then cleared. Nothing here logs a value.
 */
export function SkillSetupSection({
  skill,
  skillRaw,
  mode = "sandboxed",
  onClose,
  onSaved,
}: {
  skill: string;
  skillRaw: unknown;
  mode?: HermesAdminMode;
  onClose?: () => void;
  /** Fired after a successful inline secret/config save, so a host showing a
   * separate setup-status badge (the Installed skills list) can refresh it. */
  onSaved?: () => void;
}) {
  const state = useSkillSetup(skill, skillRaw, mode, undefined, onSaved);
  return <SkillSetupView state={state} onClose={onClose} />;
}

/** The render-only view, split out so component tests drive it with a stubbed
 * {@link SkillSetupState} (no Tauri, no network). */
export function SkillSetupView({
  state,
  onClose,
}: {
  state: SkillSetupState;
  onClose?: () => void;
}) {
  const { model } = state;
  const isLoading = state.status === "loading";
  const isError = state.status === "error";

  return (
    <div
      className="skill-setup"
      role="group"
      aria-label={`Set up ${state.skill}`}
    >
      <div className="skill-setup-header">
        <div className="skill-setup-title">
          <span className="skill-setup-skill">{state.skill}</span>
          <SetupStatusBadge badge={model.badge} />
        </div>
        {onClose ? (
          <button
            type="button"
            className="skill-setup-close"
            aria-label="Close setup"
            title="Close"
            onClick={onClose}
          >
            <IconCrossSmall size={13} ariaHidden />
          </button>
        ) : null}
      </div>

      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      {state.error ? (
        <p className="skill-setup-error" role="alert">
          <IconExclamationCircle size={14} ariaHidden />
          {state.error}
          {state.retryable ? (
            <button
              type="button"
              className="skill-setup-retry"
              onClick={state.refresh}
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : null}

      {isLoading ? (
        <p className="skill-setup-loading" role="status">
          Loading setup...
        </p>
      ) : isError && !model.hasAnySetup ? null : !model.hasAnySetup ? (
        <p className="skill-setup-none" role="status">
          This skill does not declare any required setup. It is ready to use.
        </p>
      ) : (
        <>
          {model.env.length > 0 ? (
            <section
              className="skill-setup-block"
              aria-label="Required secrets"
            >
              <h4 className="skill-setup-block-heading">
                <IconLock size={13} ariaHidden />
                Secrets
              </h4>
              <p className="skill-setup-block-note">
                Stored as environment variables for this profile. They become
                available to Hermes tools and sandboxes when the skill runs.{" "}
                {timingLabel("gateway-restart")}.
              </p>
              <ul className="skill-setup-rows">
                {model.env.map((row) => (
                  <EnvSetupRow
                    key={row.requirement.name}
                    row={row}
                    pending={state.pending.has(row.requirement.name)}
                    onSave={(value) =>
                      state.setSecret(row.requirement.name, value)
                    }
                    onDelete={() => state.deleteSecret(row.requirement.name)}
                    onReveal={() => state.revealSecret(row.requirement.name)}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {model.config.length > 0 ? (
            <section className="skill-setup-block" aria-label="Configuration">
              <h4 className="skill-setup-block-heading">
                <IconCircleInfo size={13} ariaHidden />
                Configuration
              </h4>
              <p className="skill-setup-block-note">
                Saved under skills.config in config.yaml.{" "}
                {timingLabel("next-session")}.
              </p>
              <ul className="skill-setup-rows">
                {model.config.map((row) => (
                  <ConfigSetupRow
                    key={row.requirement.key}
                    row={row}
                    pending={state.pending.has(
                      `skills.config.${state.skill}.${row.requirement.key}`,
                    )}
                    onSave={(value) =>
                      state.setConfig(row.requirement.key, value)
                    }
                    onDelete={() => state.deleteConfig(row.requirement.key)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The setup status badge: Ready / Missing API key / Missing config / Optional
 * setup skipped. Exported so the Installed skills row can render it inline. */
export function SetupStatusBadge({ badge }: { badge: SkillSetupBadgeModel }) {
  return (
    <span
      className="skill-setup-badge"
      data-tone={badge.tone}
      data-status={badge.status}
    >
      {badge.tone === "ready" ? (
        <IconCircleCheck size={12} ariaHidden />
      ) : badge.tone === "attention" ? (
        <IconWarningSign size={12} ariaHidden />
      ) : (
        <IconCircleInfo size={12} ariaHidden />
      )}
      {badge.label}
    </span>
  );
}

/** One required-secret row. Shows configured/missing state WITHOUT the value, a
 * write-only field to set/update, an optional reveal, and a clear action. */
function EnvSetupRow({
  row,
  pending,
  onSave,
  onDelete,
  onReveal,
}: {
  row: SkillEnvSetupRow;
  pending: boolean;
  onSave: (value: string) => void;
  onDelete: () => void;
  onReveal: () => Promise<string | undefined>;
}) {
  const { requirement } = row;
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();

  // Never let a draft or revealed value linger after the row unmounts.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    return () => {
      // Best-effort wipe of the local draft on unmount.
      draftRef.current = "";
    };
  }, []);

  const save = () => {
    const value = draft;
    if (value.length === 0) return;
    onSave(value);
    // Clear the draft immediately: the value now lives in Hermes, not here.
    setDraft("");
    setShow(false);
    setRevealed(false);
  };

  const reveal = async () => {
    const value = await onReveal();
    if (value !== undefined) {
      setDraft(value);
      setShow(true);
      setRevealed(true);
    }
  };

  return (
    <li className="skill-setup-row" data-configured={row.configured}>
      <div className="skill-setup-row-head">
        <label htmlFor={inputId} className="skill-setup-row-name">
          {requirement.name}
        </label>
        {requirement.required ? (
          <span className="skill-setup-tag skill-setup-tag-required">
            Required
          </span>
        ) : (
          <span className="skill-setup-tag">Optional</span>
        )}
        <span
          className="skill-setup-row-state"
          data-configured={row.configured}
        >
          {row.configured ? "Configured" : "Not set"}
        </span>
      </div>

      {requirement.prompt ? (
        <p className="skill-setup-row-prompt">{requirement.prompt}</p>
      ) : null}
      {requirement.help ? (
        <p className="skill-setup-row-help">{requirement.help}</p>
      ) : null}
      {requirement.requiredFor ? (
        <p className="skill-setup-row-help">
          Needed for {requirement.requiredFor}.
        </p>
      ) : null}
      {row.configured && row.preview ? (
        <p
          className="skill-setup-row-preview"
          aria-label="Current value preview"
        >
          Current: {row.preview}
        </p>
      ) : null}

      <div className="skill-setup-field">
        <input
          id={inputId}
          className="skill-setup-input"
          type={show ? "text" : "password"}
          value={draft}
          placeholder={
            row.configured ? "Enter a new value to replace" : "Enter value"
          }
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          aria-label={`${requirement.name} value`}
          onChange={(event) => {
            setRevealed(false);
            setDraft(event.currentTarget.value);
          }}
        />
        <button
          type="button"
          className="skill-setup-field-toggle"
          aria-label={show ? "Hide value" : "Show value"}
          title={show ? "Hide" : "Show"}
          onClick={() => setShow((value) => !value)}
        >
          {show ? (
            <IconEyeSlash size={14} ariaHidden />
          ) : (
            <IconEyeOpen size={14} ariaHidden />
          )}
        </button>
      </div>

      {revealed ? (
        <p className="skill-setup-row-revealed" role="status">
          Showing the stored value. It is not saved anywhere in June.
        </p>
      ) : null}

      <div className="skill-setup-row-actions">
        <button
          type="button"
          className="skill-setup-save"
          disabled={pending || draft.length === 0}
          onClick={save}
        >
          {pending ? "Saving" : row.configured ? "Update" : "Save"}
        </button>
        {row.configured ? (
          <>
            <button
              type="button"
              className="skill-setup-reveal"
              disabled={pending}
              onClick={() => void reveal()}
            >
              Reveal current
            </button>
            <button
              type="button"
              className="skill-setup-clear"
              disabled={pending}
              onClick={onDelete}
            >
              Clear
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

/** One non-secret config row. Shows current value, default, prompt/description,
 * a field to set/update, validation, and a clear-to-default action. */
function ConfigSetupRow({
  row,
  pending,
  onSave,
  onDelete,
}: {
  row: SkillConfigSetupRow;
  pending: boolean;
  onSave: (value: string) => void;
  onDelete: () => void;
}) {
  const { requirement } = row;
  // Never seed the draft from a masked placeholder: the row's `current` may be
  // `[redacted]`, and saving that back would overwrite the real Hermes value
  // with the literal placeholder. A redacted field starts empty and requires a
  // typed replacement.
  const [draft, setDraft] = useState(row.redacted ? "" : (row.current ?? ""));
  const [validationError, setValidationError] = useState<string>();
  const inputId = useId();

  // Reflect a refreshed current value into the field when it changes and the
  // user has not started editing (draft still matches the old current).
  const lastCurrent = useRef(row.current);
  useEffect(() => {
    if (lastCurrent.current !== row.current) {
      lastCurrent.current = row.current;
      setDraft(row.redacted ? "" : (row.current ?? ""));
    }
  }, [row.current, row.redacted]);

  const save = () => {
    if (row.redacted && draft.trim() === "") {
      // The stored value is hidden; an empty save would clobber it. Require a
      // new value, or let the user reset to default to clear it explicitly.
      setValidationError(
        "Enter a new value to replace the hidden one, or reset to default.",
      );
      return;
    }
    const result = validateConfigValue(requirement, draft);
    if (!result.ok) {
      setValidationError(result.message);
      return;
    }
    setValidationError(undefined);
    onSave(draft);
  };

  return (
    <li className="skill-setup-row">
      <div className="skill-setup-row-head">
        <label htmlFor={inputId} className="skill-setup-row-name">
          {requirement.prompt ?? requirement.key}
        </label>
        {requirement.required ? (
          <span className="skill-setup-tag skill-setup-tag-required">
            Required
          </span>
        ) : (
          <span className="skill-setup-tag">Optional</span>
        )}
        {row.modified ? (
          <span className="skill-setup-row-state" data-configured>
            Modified
          </span>
        ) : (
          <span className="skill-setup-row-state">Default</span>
        )}
      </div>

      {requirement.description ? (
        <p className="skill-setup-row-help">{requirement.description}</p>
      ) : null}
      {requirement.default !== undefined ? (
        <p className="skill-setup-row-help">
          Default: <code>{requirement.default}</code>
        </p>
      ) : null}

      <div className="skill-setup-field">
        <input
          id={inputId}
          className="skill-setup-input"
          type="text"
          value={draft}
          placeholder={
            row.redacted
              ? "Hidden; enter a new value to replace it"
              : (requirement.default ?? "Enter value")
          }
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          aria-label={`${requirement.key} value`}
          onChange={(event) => {
            setValidationError(undefined);
            setDraft(event.currentTarget.value);
          }}
        />
      </div>

      {validationError ? (
        <p className="skill-setup-field-error" role="alert">
          {validationError}
        </p>
      ) : null}

      <div className="skill-setup-row-actions">
        <button
          type="button"
          className="skill-setup-save"
          disabled={pending}
          onClick={save}
        >
          {pending ? "Saving" : "Save"}
        </button>
        {row.current !== undefined && row.current.length > 0 ? (
          <button
            type="button"
            className="skill-setup-clear"
            disabled={pending}
            onClick={onDelete}
          >
            Reset to default
          </button>
        ) : null}
      </div>
    </li>
  );
}
