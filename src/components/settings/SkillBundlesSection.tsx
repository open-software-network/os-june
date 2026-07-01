import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconLayersThree } from "central-icons/IconLayersThree";
import { IconLayersTwo } from "central-icons/IconLayersTwo";
import { IconPencil } from "central-icons/IconPencil";
import { IconPlay } from "central-icons/IconPlay";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useMemo, useState } from "react";
import {
  bundleDisplayName,
  normalizeBundleSlug,
  parseBundleSkillsInput,
  useSkillBundles,
  type HermesAdminMode,
  type SkillBundle,
  type HermesSkillInfo,
  type ResolvedSkillBundle,
  type SkillBundlesState,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";

type SkillBundlesSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the
   * safe sandboxed runtime. */
  mode?: HermesAdminMode;
  /** Starts a new agent chat that runs a bundle's slash command. When omitted,
   * the "Start chat" action is hidden. */
  onStartChat?: (prompt: string) => void;
};

/**
 * June's native Skill Bundles manager (admin surfaces spec 11). Lists the
 * bundles stored under the targeted profile's `skill-bundles` directory, with
 * create / edit / delete / duplicate / reload, a slash-command preview, resolved
 * vs missing member status, slug-collision warnings, and "start chat with this
 * bundle". Data and validation live in {@link useSkillBundles}; this component
 * is presentation + the editor form's local state.
 */
export function SkillBundlesSection({
  mode = "sandboxed",
  onStartChat,
}: SkillBundlesSectionProps) {
  const state = useSkillBundles(mode, onStartChat);
  return (
    <SkillBundlesView state={state} mode={mode} canStartChat={!!onStartChat} />
  );
}

/** The editor target: a new bundle, or an existing one being edited. */
type EditorTarget = { kind: "create" } | { kind: "edit"; bundle: SkillBundle };

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link SkillBundlesState} (no Tauri, no network) and assert the list, the
 * warnings, and the editor wiring.
 */
export function SkillBundlesView({
  state,
  mode = "sandboxed",
  canStartChat,
}: {
  state: SkillBundlesState;
  mode?: HermesAdminMode;
  canStartChat?: boolean;
}) {
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasBundles = state.bundles.length > 0;

  if (editor) {
    return (
      <BundleEditor
        target={editor}
        state={state}
        mode={state.mode ?? mode}
        onClose={() => setEditor(null)}
      />
    );
  }

  return (
    <section
      className="settings-group skill-bundles"
      aria-labelledby="skill-bundles-heading"
    >
      <h2 id="skill-bundles-heading" className="settings-group-heading">
        Bundles
      </h2>
      <p className="settings-group-description">
        Group several skills under one slash command, like /backend-dev, so you
        can start a focused chat in one step. Changes apply to new sessions.{" "}
        <ModeNote
          mode={state.mode ?? mode}
          profile={state.profile}
          show={!isUnavailable}
        />
      </p>

      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      <div className="settings-card skill-bundles-card">
        <div className="skill-bundles-toolbar">
          <button
            type="button"
            className="skill-bundles-new"
            disabled={isUnavailable}
            onClick={() => setEditor({ kind: "create" })}
          >
            <IconPlusMedium size={14} ariaHidden />
            New bundle
          </button>
          <button
            type="button"
            className="skill-bundles-refresh"
            disabled={isUnavailable || isLoadingFirst}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Reload
          </button>
        </div>

        {state.error && hasBundles ? (
          <p className="settings-row-error skill-bundles-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="skill-bundles-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to create and manage skill bundles for your sessions."
            />
          ) : isErrored ? (
            <ErrorState
              message={state.error ?? "Could not load bundles from Hermes."}
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isLoadingFirst ? (
            <p className="skill-bundles-loading" role="status">
              Loading bundles...
            </p>
          ) : !hasBundles ? (
            <EmptyState
              title="No bundles yet"
              description="Create a bundle to load several skills under one slash command."
            />
          ) : (
            <ul className="skill-bundles-list">
              {state.bundles.map((bundle) => (
                <BundleRow
                  key={bundle.bundle.slug}
                  bundle={bundle}
                  pending={state.pending.has(bundle.bundle.slug)}
                  canStartChat={canStartChat}
                  onEdit={() =>
                    setEditor({ kind: "edit", bundle: bundle.bundle })
                  }
                  onDuplicate={() => void state.duplicate(bundle.bundle.slug)}
                  onDelete={() => void state.remove(bundle.bundle.slug)}
                  onStartChat={() => state.startChat(bundle.bundle.slug)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** The sandbox/full-mode + profile context line, so a write's blast radius is
 * never ambiguous. */
function ModeNote({
  mode,
  profile,
  show,
}: {
  mode: HermesAdminMode;
  profile?: string;
  show: boolean;
}) {
  if (!show) return null;
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  return (
    <span className="skill-bundles-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** One bundle row: name + slash command, description, member status, collision
 * warning, and the row actions. */
function BundleRow({
  bundle,
  pending,
  canStartChat,
  onEdit,
  onDuplicate,
  onDelete,
  onStartChat,
}: {
  bundle: ResolvedSkillBundle;
  pending: boolean;
  canStartChat?: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onStartChat: () => void;
}) {
  const name = bundleDisplayName(bundle.bundle);
  const missingCount = bundle.members.filter((m) => m.missing).length;

  return (
    <li className="skill-bundle-row">
      <div className="skill-bundle-main">
        <div className="skill-bundle-headline">
          <span className="skill-bundle-name">{name}</span>
          <code className="skill-bundle-slash">{bundle.slashCommand}</code>
        </div>
        {bundle.bundle.description ? (
          <p className="skill-bundle-description">
            {bundle.bundle.description}
          </p>
        ) : null}

        <ul className="skill-bundle-members" aria-label="Skills in this bundle">
          {bundle.members.map((member, index) => (
            <li
              key={`${member.identifier}-${index}`}
              className="skill-bundle-member"
              data-missing={member.missing}
            >
              <span className="skill-bundle-member-name">
                {member.identifier}
              </span>
              {member.missing ? (
                <span className="skill-bundle-member-missing">
                  <IconWarningSign size={11} ariaHidden />
                  Not installed
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        {missingCount > 0 ? (
          <p className="skill-bundle-note skill-bundle-note-warning">
            <IconWarningSign size={13} ariaHidden />
            {missingCount === 1
              ? "1 skill is not installed. Hermes will skip it when the bundle runs."
              : `${missingCount} skills are not installed. Hermes will skip them when the bundle runs.`}
          </p>
        ) : null}
        {bundle.collidesWithSkill ? (
          <p className="skill-bundle-note skill-bundle-note-warning">
            <IconCircleInfo size={13} ariaHidden />A skill named{" "}
            {bundle.slashCommand} is installed. This bundle takes precedence and
            runs instead.
          </p>
        ) : null}
      </div>

      <div className="skill-bundle-actions">
        {canStartChat ? (
          <button
            type="button"
            className="skill-bundle-action skill-bundle-start"
            disabled={pending}
            onClick={onStartChat}
            title="Start a chat with this bundle"
          >
            <IconPlay size={13} ariaHidden />
            Start chat
          </button>
        ) : null}
        <button
          type="button"
          className="skill-bundle-action"
          disabled={pending}
          onClick={onEdit}
          aria-label={`Edit ${name}`}
          title="Edit"
        >
          <IconPencil size={14} ariaHidden />
        </button>
        <button
          type="button"
          className="skill-bundle-action"
          disabled={pending}
          onClick={onDuplicate}
          aria-label={`Duplicate ${name}`}
          title="Duplicate"
        >
          <IconLayersTwo size={14} ariaHidden />
        </button>
        <button
          type="button"
          className="skill-bundle-action skill-bundle-delete"
          disabled={pending}
          onClick={onDelete}
          aria-label={`Delete ${name}`}
          title="Delete"
        >
          <IconTrashCan size={14} ariaHidden />
        </button>
      </div>
    </li>
  );
}

/** The create/edit form. Owns its draft state and runs the shared validator on
 * every change so errors block saving and warnings (missing skills, slug
 * collision) are shown but do not. */
function BundleEditor({
  target,
  state,
  mode,
  onClose,
}: {
  target: EditorTarget;
  state: SkillBundlesState;
  mode: HermesAdminMode;
  onClose: () => void;
}) {
  const editingSlug = target.kind === "edit" ? target.bundle.slug : undefined;
  const initial = target.kind === "edit" ? target.bundle : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  // Whether the user has hand-edited the slug; until then it auto-derives from
  // the name so the common case needs no extra typing.
  const [slugTouched, setSlugTouched] = useState(target.kind === "edit");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [skillsInput, setSkillsInput] = useState(
    (initial?.skills ?? []).join("\n"),
  );
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  const effectiveSlug = slugTouched
    ? normalizeBundleSlug(slug)
    : normalizeBundleSlug(name);

  const draft: SkillBundle = useMemo(
    () => ({
      slug: effectiveSlug,
      name: name.trim() || undefined,
      description: description.trim() || undefined,
      skills: parseBundleSkillsInput(skillsInput),
      instructions: instructions.trim() || undefined,
    }),
    [effectiveSlug, name, description, skillsInput, instructions],
  );

  const validation = state.validate(draft, editingSlug);
  const slugIssues = validation.issues.filter((i) => i.field === "slug");
  const skillsIssues = validation.issues.filter((i) => i.field === "skills");

  async function handleSave() {
    setSubmitError(undefined);
    if (!validation.canSave) return;
    setSaving(true);
    try {
      await state.save(
        draft,
        editingSlug && editingSlug !== draft.slug ? editingSlug : undefined,
      );
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Could not save the bundle.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="settings-group skill-bundle-editor"
      aria-labelledby="skill-bundle-editor-heading"
    >
      <button
        type="button"
        className="skill-bundle-editor-back"
        onClick={onClose}
      >
        <IconChevronLeftSmall size={14} ariaHidden />
        Back to bundles
      </button>
      <h2 id="skill-bundle-editor-heading" className="settings-group-heading">
        {target.kind === "edit" ? "Edit bundle" : "New bundle"}
      </h2>

      <div className="settings-card skill-bundle-editor-card">
        <label className="skill-bundle-field">
          <span className="skill-bundle-field-label">Name</span>
          <input
            type="text"
            value={name}
            placeholder="Backend dev"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>

        <label className="skill-bundle-field">
          <span className="skill-bundle-field-label">Slash command</span>
          <div className="skill-bundle-slug-input">
            <span className="skill-bundle-slug-prefix" aria-hidden>
              /
            </span>
            <input
              type="text"
              value={slugTouched ? slug : effectiveSlug}
              placeholder="backend-dev"
              aria-label="Slash command"
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.currentTarget.value);
              }}
            />
          </div>
          <span className="skill-bundle-field-hint">
            Runs as {effectiveSlug ? `/${effectiveSlug}` : "a slash command"}.
          </span>
          {slugIssues.map((issue, index) => (
            <IssueLine key={index} issue={issue} />
          ))}
        </label>

        <label className="skill-bundle-field">
          <span className="skill-bundle-field-label">Description</span>
          <input
            type="text"
            value={description}
            placeholder="Skills for backend work"
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </label>

        <label className="skill-bundle-field">
          <span className="skill-bundle-field-label">Skills</span>
          <textarea
            value={skillsInput}
            rows={4}
            placeholder={"One skill per line, e.g.\nbackend-dev\ndatabase"}
            onChange={(event) => setSkillsInput(event.currentTarget.value)}
          />
          <span className="skill-bundle-field-hint">
            One skill identifier per line. Missing skills are allowed and
            skipped when the bundle runs.
          </span>
          {skillsIssues.map((issue, index) => (
            <IssueLine key={index} issue={issue} />
          ))}
          <SkillPicker
            skills={state.skills}
            selected={draft.skills}
            onAdd={(identifier) =>
              setSkillsInput((current) =>
                current.trim()
                  ? `${current.trim()}\n${identifier}`
                  : identifier,
              )
            }
          />
        </label>

        <label className="skill-bundle-field">
          <span className="skill-bundle-field-label">
            Instructions (optional)
          </span>
          <textarea
            value={instructions}
            rows={3}
            placeholder="Extra guidance Hermes applies when this bundle runs."
            onChange={(event) => setInstructions(event.currentTarget.value)}
          />
        </label>

        {submitError ? (
          <p className="settings-row-error" role="alert">
            <IconExclamationCircle size={14} ariaHidden />
            {submitError}
          </p>
        ) : null}

        <div className="skill-bundle-editor-actions">
          <button
            type="button"
            className="skill-bundle-editor-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="skill-bundle-editor-save"
            disabled={!validation.canSave || saving}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving..." : "Save bundle"}
          </button>
        </div>
        <ModeNote mode={mode} profile={state.profile} show />
      </div>
    </section>
  );
}

/** A single validation issue line, styled by severity. */
function IssueLine({
  issue,
}: {
  issue: { severity: "error" | "warning"; message: string };
}) {
  return (
    <span
      className="skill-bundle-issue"
      data-severity={issue.severity}
      role={issue.severity === "error" ? "alert" : "status"}
    >
      {issue.severity === "error" ? (
        <IconExclamationCircle size={12} ariaHidden />
      ) : (
        <IconWarningSign size={12} ariaHidden />
      )}
      {issue.message}
    </span>
  );
}

/** A compact picker of installed skills not already in the draft, so the user
 * can add a member without typing its exact identifier. */
function SkillPicker({
  skills,
  selected,
  onAdd,
}: {
  skills: HermesSkillInfo[];
  selected: string[];
  onAdd: (identifier: string) => void;
}) {
  const selectedSet = useMemo(
    () => new Set(selected.map((s) => s.trim().toLowerCase())),
    [selected],
  );
  const available = useMemo(
    () =>
      skills
        .filter((skill) => !selectedSet.has(skill.name.trim().toLowerCase()))
        .slice(0, 12),
    [skills, selectedSet],
  );
  if (available.length === 0) return null;
  return (
    <div className="skill-bundle-picker" aria-label="Add an installed skill">
      {available.map((skill) => (
        <button
          key={skill.name}
          type="button"
          className="skill-bundle-picker-chip"
          onClick={() => onAdd(skill.name)}
        >
          <IconPlusMedium size={11} ariaHidden />
          {skill.name}
        </button>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="skill-bundles-empty" role="status">
      <span className="skill-bundles-empty-icon" aria-hidden>
        <IconLayersThree size={22} />
      </span>
      <p className="skill-bundles-empty-title">{title}</p>
      <p className="skill-bundles-empty-description">{description}</p>
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
    <div className="skill-bundles-error" role="alert">
      <span className="skill-bundles-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="skill-bundles-empty-title">Couldn't load bundles</p>
      <p className="skill-bundles-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="skill-bundles-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
