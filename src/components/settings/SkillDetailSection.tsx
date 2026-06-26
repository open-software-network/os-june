import { IconArrowLeft } from "central-icons/IconArrowLeft";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCode } from "central-icons/IconCode";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconFileText } from "central-icons/IconFileText";
import { IconFloppyDisk1 } from "central-icons/IconFloppyDisk1";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconLock } from "central-icons/IconLock";
import { IconPencilLine } from "central-icons/IconPencilLine";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useMemo, useState } from "react";
import {
  hasSupportingFiles,
  lifecycleClassMeta,
  platformRestrictions,
  skillActivation,
  skillLifecyclePolicy,
  skillPath,
  skillTags,
  sourceMeta,
  timingLabel,
  useSkillDetail,
  useSkillLifecycle,
  type HermesAdminMode,
  type HermesSkillInfo,
  type SkillContentIssue,
  type SkillDetailState,
  type SkillDiff,
  type SkillLifecycleState,
  type SkillSupportingFiles,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";
import { SkillLifecycleActions } from "./SkillLifecycleActions";
import { SkillSetupSection } from "./SkillSetupSection";

/**
 * The skill detail viewer and safe editor (spec 05). Opened as a sub-view off
 * the Installed skills list (the per-row open arrow), it shows a skill's
 * metadata, provenance, supporting files, declared setup, and its SKILL.md, and
 * lets the user safely edit a writable skill's SKILL.md.
 *
 * SAFE EDITING is enforced, not styled: a read-only skill (external dir) has no
 * editor at all; a writable skill validates frontmatter/required fields/size and
 * scans for secret-looking values BEFORE save, and requires a diff confirmation.
 * Bundled and hub skills carry an honest pre-edit warning that local edits affect
 * future updates. Every save's apply timing ("applies next session") is stated.
 *
 * This is a settings SURFACE: it reuses the same `settings-*` chrome and the
 * shared {@link AdminNotifications} so it sits next to the chat without looking
 * out of place. Data lives in {@link useSkillDetail}; this is presentation plus
 * the local draft-editing/confirm-dialog state.
 */
export function SkillDetailSection({
  skill,
  info,
  mode = "sandboxed",
  onBack,
}: {
  skill: string;
  /** The skill's inventory metadata, passed from the list so the header renders
   * without a second fetch. Optional so the surface still works from a deep
   * link with only a name. */
  info?: HermesSkillInfo;
  mode?: HermesAdminMode;
  /** Returns to the installed skills list. */
  onBack?: () => void;
}) {
  const state = useSkillDetail(skill, info, mode);
  // Lifecycle actions refresh the skill's content on a successful mutation so the
  // detail view reflects a reset / update.
  const lifecycle = useSkillLifecycle(mode, undefined, state.refresh);
  return (
    <SkillDetailView state={state} lifecycle={lifecycle} onBack={onBack} />
  );
}

/** The render-only view, split out so component tests drive it with a stubbed
 * {@link SkillDetailState} (no Tauri, no network). */
export function SkillDetailView({
  state,
  lifecycle,
  onBack,
}: {
  state: SkillDetailState;
  /** The lifecycle action state, when available, so the detail surface can offer
   * update / audit / uninstall / reset and explain the disabled ones. */
  lifecycle?: SkillLifecycleState;
  onBack?: () => void;
}) {
  const { info, policy } = state;
  const isLoading = state.status === "loading";
  const isError = state.status === "error" && !state.original;
  const meta = sourceMeta(info?.source ?? "unknown");
  const headingId = "skill-detail-heading";

  return (
    <section
      className="settings-group skill-detail"
      aria-labelledby={headingId}
    >
      <div className="skill-detail-topbar">
        {onBack ? (
          <button type="button" className="skill-detail-back" onClick={onBack}>
            <IconArrowLeft size={14} ariaHidden />
            Installed skills
          </button>
        ) : null}
        <button
          type="button"
          className="skill-detail-refresh"
          disabled={isLoading}
          onClick={state.refresh}
        >
          <IconArrowRotateClockwise size={14} ariaHidden />
          Refresh
        </button>
      </div>

      <h2 id={headingId} className="settings-group-heading skill-detail-name">
        {info?.name ?? state.skill}
        <span className="skill-detail-source" data-source={info?.source}>
          {meta.label}
        </span>
        {info?.version ? (
          <span className="skill-detail-version">v{info.version}</span>
        ) : null}
        {policy.editable ? null : (
          <span className="skill-detail-readonly" title={policy.readOnlyReason}>
            <IconLock size={12} ariaHidden />
            Read only
          </span>
        )}
      </h2>
      <p className="settings-group-description">
        {info?.description ?? meta.blurb}{" "}
        <span className="skill-detail-mode-note">
          Targeting the{" "}
          {state.mode === "unrestricted" ? "Full mode" : "Sandboxed"} runtime
          (profile {state.profile}). Edits apply to new sessions.
        </span>
      </p>

      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      {state.error ? (
        <p className="skill-detail-error" role="alert">
          <IconExclamationCircle size={14} ariaHidden />
          {state.error}
          {state.retryable ? (
            <button
              type="button"
              className="skill-detail-retry"
              onClick={state.refresh}
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : null}

      {isLoading ? (
        <p className="skill-detail-loading" role="status">
          Loading skill...
        </p>
      ) : isError ? null : (
        <>
          <MetadataCard info={info} />

          {info && lifecycle ? (
            <LifecycleCard info={info} lifecycle={lifecycle} />
          ) : null}

          <SupportingFilesCard files={state.supportingFiles} />

          {info ? (
            <div className="settings-card skill-detail-setup-card">
              <h3 className="skill-detail-card-heading">Setup</h3>
              <SkillSetupSection
                skill={state.skill}
                skillRaw={info.raw}
                mode={state.mode}
              />
            </div>
          ) : null}

          <SkillDocumentCard state={state} />
        </>
      )}
    </section>
  );
}

/** The metadata card: category, tags, platform restrictions, conditional
 * activation, on-disk path, and provenance blurb. Renders only what the
 * inventory actually reports. */
function MetadataCard({ info }: { info?: HermesSkillInfo }) {
  const tags = info ? skillTags(info) : undefined;
  const restrictions = info ? platformRestrictions(info) : undefined;
  const activation = info ? skillActivation(info) : undefined;
  const path = info ? skillPath(info) : undefined;
  const author = info ? readAuthor(info) : undefined;
  const meta = sourceMeta(info?.source ?? "unknown");

  return (
    <div className="settings-card skill-detail-meta-card">
      <h3 className="skill-detail-card-heading">Details</h3>
      <dl className="skill-detail-meta-grid">
        <MetaItem label="Source" value={meta.label} hint={meta.blurb} />
        {author ? <MetaItem label="Author" value={author} /> : null}
        {info?.version ? (
          <MetaItem label="Version" value={info.version} />
        ) : null}
        <MetaItem label="Enabled" value={info?.enabled ? "Yes" : "No"} />
        {restrictions ? (
          <MetaItem
            label="Platforms"
            value={`${restrictions.join(", ")} only`}
          />
        ) : null}
        {activation?.requires ? (
          <MetaItem label="Requires" value={activation.requires.join(", ")} />
        ) : null}
        {activation?.fallback ? (
          <MetaItem
            label="Falls back to"
            value={activation.fallback.join(", ")}
          />
        ) : null}
        {path ? <MetaItem label="Path" value={path} mono /> : null}
      </dl>
      {tags && tags.length > 0 ? (
        <div className="skill-detail-tags" aria-label="Tags">
          {tags.map((tag) => (
            <span key={tag} className="skill-detail-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The lifecycle card: the skill's provenance class, then the valid lifecycle
 * actions plus the invalid ones with their honest reasons. */
function LifecycleCard({
  info,
  lifecycle,
}: {
  info: HermesSkillInfo;
  lifecycle: SkillLifecycleState;
}) {
  const policy = skillLifecyclePolicy(info);
  const meta = lifecycleClassMeta(policy.lifecycleClass);
  return (
    <div className="settings-card skill-detail-lifecycle-card">
      <h3 className="skill-detail-card-heading">Manage</h3>
      <p className="skill-detail-lifecycle-blurb">{meta.blurb}</p>
      {policy.locallyModified ? (
        <p className="skill-detail-lifecycle-modified" role="note">
          <IconWarningSign size={13} ariaHidden />
          This skill has local edits. Updating or resetting it replaces them.
        </p>
      ) : null}
      <SkillLifecycleActions
        skill={info}
        policy={policy}
        state={lifecycle}
        variant="detail"
      />
    </div>
  );
}

function MetaItem({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="skill-detail-meta-item">
      <dt className="skill-detail-meta-label">{label}</dt>
      <dd
        className={`skill-detail-meta-value${mono ? " skill-detail-meta-mono" : ""}`}
        title={hint}
      >
        {value}
      </dd>
    </div>
  );
}

/** Supporting files grouped by references / templates / scripts / assets, with
 * scripts flagged because they run in June's sandbox/full-mode runtime. */
function SupportingFilesCard({ files }: { files: SkillSupportingFiles }) {
  if (!hasSupportingFiles(files)) {
    return (
      <div className="settings-card skill-detail-files-card">
        <h3 className="skill-detail-card-heading">Supporting files</h3>
        <p className="skill-detail-files-empty">
          No supporting files reported for this skill.
        </p>
      </div>
    );
  }
  return (
    <div className="settings-card skill-detail-files-card">
      <h3 className="skill-detail-card-heading">Supporting files</h3>
      <FileGroup label="References" paths={files.references} />
      <FileGroup label="Templates" paths={files.templates} />
      <FileGroup
        label="Scripts"
        paths={files.scripts}
        note="Scripts run in the targeted runtime when the skill executes them."
        danger
      />
      <FileGroup label="Assets" paths={files.assets} />
      <FileGroup label="Other" paths={files.other} />
    </div>
  );
}

function FileGroup({
  label,
  paths,
  note,
  danger,
}: {
  label: string;
  paths: string[];
  note?: string;
  danger?: boolean;
}) {
  if (paths.length === 0) return null;
  return (
    <div
      className="skill-detail-file-group"
      data-danger={danger ? "true" : undefined}
    >
      <h4 className="skill-detail-file-group-heading">
        {danger ? (
          <IconWarningSign size={12} ariaHidden />
        ) : (
          <IconFolder1 size={12} ariaHidden />
        )}
        {label}
        <span className="skill-detail-file-count">{paths.length}</span>
      </h4>
      {note ? <p className="skill-detail-file-note">{note}</p> : null}
      <ul className="skill-detail-file-list">
        {paths.map((path) => (
          <li key={path} className="skill-detail-file">
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The SKILL.md card: a read view (frontmatter separated from body) for a
 * read-only skill, or the safe editor for a writable one. */
function SkillDocumentCard({ state }: { state: SkillDetailState }) {
  if (!state.policy.editable) {
    return <SkillDocumentReadView state={state} />;
  }
  return <SkillDocumentEditor state={state} />;
}

/** Read-only render: frontmatter block, then the markdown body, as plain text
 * (never executed). */
function SkillDocumentReadView({ state }: { state: SkillDetailState }) {
  const { parts } = state;
  return (
    <div className="settings-card skill-detail-doc-card">
      <div className="skill-detail-doc-header">
        <h3 className="skill-detail-card-heading">
          <IconFileText size={14} ariaHidden />
          {state.relativePath ?? "SKILL.md"}
        </h3>
        <span className="skill-detail-doc-readonly">
          <IconLock size={12} ariaHidden />
          {state.policy.readOnlyReason ?? "Read only"}
        </span>
      </div>
      {parts.hasFrontmatter ? (
        <>
          <p className="skill-detail-doc-subheading">Frontmatter</p>
          <pre className="skill-detail-doc-frontmatter">
            <code>{parts.frontmatter}</code>
          </pre>
        </>
      ) : null}
      <p className="skill-detail-doc-subheading">Instructions</p>
      <pre className="skill-detail-doc-body">
        <code>{parts.body || "(empty)"}</code>
      </pre>
    </div>
  );
}

/** The safe editor: a pre-edit risk warning (bundled/hub), a validated
 * textarea, inline issues, and a diff-before-save confirmation. */
function SkillDocumentEditor({ state }: { state: SkillDetailState }) {
  const [confirming, setConfirming] = useState(false);
  const errors = state.validation.issues.filter(
    (issue) => issue.severity === "error",
  );
  const warnings = state.validation.issues.filter(
    (issue) => issue.severity === "warning",
  );
  const canSave = state.dirty && state.validation.canSave && !state.saving;

  return (
    <div className="settings-card skill-detail-doc-card">
      <div className="skill-detail-doc-header">
        <h3 className="skill-detail-card-heading">
          <IconPencilLine size={14} ariaHidden />
          Edit {state.relativePath ?? "SKILL.md"}
        </h3>
        <span className="skill-detail-doc-timing">
          {timingLabel("next-session")}
        </span>
      </div>

      {state.policy.warning ? (
        <p className="skill-detail-doc-warning" role="note">
          <IconCircleInfo size={13} ariaHidden />
          {state.policy.warning}
        </p>
      ) : null}

      <label className="skill-detail-editor-label" htmlFor="skill-md-editor">
        Skill instructions and metadata
      </label>
      <textarea
        id="skill-md-editor"
        className="skill-detail-editor"
        spellCheck={false}
        value={state.draft}
        aria-invalid={errors.length > 0}
        aria-describedby={
          errors.length > 0 ? "skill-md-editor-issues" : undefined
        }
        onChange={(event) => state.setDraft(event.currentTarget.value)}
      />

      {errors.length > 0 || warnings.length > 0 ? (
        <ul className="skill-detail-issues" id="skill-md-editor-issues">
          {errors.map((issue, index) => (
            <IssueRow key={`e-${index}`} issue={issue} />
          ))}
          {warnings.map((issue, index) => (
            <IssueRow key={`w-${index}`} issue={issue} />
          ))}
        </ul>
      ) : null}

      <div className="skill-detail-editor-actions">
        <button
          type="button"
          className="skill-detail-revert"
          disabled={!state.dirty || state.saving}
          onClick={state.revert}
        >
          Revert
        </button>
        <button
          type="button"
          className="skill-detail-save"
          disabled={!canSave}
          onClick={() => setConfirming(true)}
        >
          <IconFloppyDisk1 size={14} ariaHidden />
          {state.saving ? "Saving..." : "Review and save"}
        </button>
      </div>

      {confirming ? (
        <SaveConfirm
          diff={state.diff}
          warnings={warnings}
          saving={state.saving}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            state.save();
            setConfirming(false);
          }}
        />
      ) : null}
    </div>
  );
}

function IssueRow({ issue }: { issue: SkillContentIssue }) {
  return (
    <li className="skill-detail-issue" data-severity={issue.severity}>
      {issue.severity === "error" ? (
        <IconExclamationCircle size={13} ariaHidden />
      ) : (
        <IconWarningSign size={13} ariaHidden />
      )}
      <span>
        {issue.line ? <strong>Line {issue.line}: </strong> : null}
        {issue.message}
      </span>
    </li>
  );
}

/** The diff-before-save confirmation. Shows the line diff and, when present, a
 * reminder of the secret-looking-value warnings before the user commits. */
function SaveConfirm({
  diff,
  warnings,
  saving,
  onCancel,
  onConfirm,
}: {
  diff: SkillDiff;
  warnings: SkillContentIssue[];
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="skill-detail-confirm"
      role="dialog"
      aria-label="Review changes before saving"
      aria-modal="false"
    >
      <p className="skill-detail-confirm-summary">
        <IconCode size={13} ariaHidden />
        {diff.addedCount} added, {diff.removedCount} removed. This applies to
        new sessions.
      </p>
      {warnings.length > 0 ? (
        <p className="skill-detail-confirm-warning" role="note">
          <IconWarningSign size={13} ariaHidden />
          One or more values look like secrets. Secrets belong in .env or secret
          config, not in SKILL.md.
        </p>
      ) : null}
      <DiffView diff={diff} />
      <div className="skill-detail-confirm-actions">
        <button
          type="button"
          className="skill-detail-confirm-cancel"
          onClick={onCancel}
        >
          Keep editing
        </button>
        <button
          type="button"
          className="skill-detail-confirm-save"
          disabled={saving}
          onClick={onConfirm}
        >
          Save changes
        </button>
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: SkillDiff }) {
  // Cap rendered lines so a huge rewrite cannot blow up the dialog; the counts
  // above still report the full change.
  const MAX = 200;
  const lines = useMemo(() => diff.lines.slice(0, MAX), [diff.lines]);
  return (
    <pre className="skill-detail-diff" aria-label="Changes">
      <code>
        {lines.map((line, index) => (
          <span
            key={index}
            className="skill-detail-diff-line"
            data-kind={line.kind}
          >
            {line.kind === "added"
              ? "+ "
              : line.kind === "removed"
                ? "- "
                : "  "}
            {line.text}
            {"\n"}
          </span>
        ))}
        {diff.lines.length > MAX ? (
          <span className="skill-detail-diff-line" data-kind="unchanged">
            {`  ...and ${diff.lines.length - MAX} more lines\n`}
          </span>
        ) : null}
      </code>
    </pre>
  );
}

/** Reads an author/publisher string from a skill's raw payload, when reported. */
function readAuthor(skill: HermesSkillInfo): string | undefined {
  const record =
    skill.raw && typeof skill.raw === "object" && !Array.isArray(skill.raw)
      ? (skill.raw as Record<string, unknown>)
      : undefined;
  if (!record) return undefined;
  for (const key of ["author", "publisher", "maintainer", "owner"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
