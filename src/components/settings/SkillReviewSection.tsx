import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconBrain2 } from "central-icons/IconBrain2";
import { IconCheckmark1 } from "central-icons/IconCheckmark1";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCode } from "central-icons/IconCode";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconRobot2 } from "central-icons/IconRobot2";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useState } from "react";
import {
  affectedFiles,
  canApprove,
  hasRedactedContent,
  opMeta,
  writeSourceMeta,
  useSkillReview,
  writeGist,
  WRITE_APPROVAL_OFF_COPY,
  WRITE_APPROVAL_ON_COPY,
  type HermesAdminMode,
  type PendingSkillWrite,
  type PendingSkillWriteFile,
  type SkillReviewState,
} from "../../lib/hermes-admin";
import { Switch } from "../ui/Switch";
import { AdminNotifications } from "./AdminNotifications";

type SkillReviewSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the
   * safe sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native agent-managed skill write review queue (admin surfaces spec 12).
 * Surfaces the skill changes the agent proposes (writes / edits / deletes) so
 * the user can read the diff, see where each change came from, and approve or
 * reject it before it lands in procedural memory. Also exposes the
 * `skills.write_approval` gate that decides whether agent writes are staged for
 * review at all.
 *
 * This is the human-in-the-loop gate for agent-authored skill changes. The data
 * lives entirely in {@link useSkillReview}; this component is presentation +
 * local expand state.
 */
export function SkillReviewSection({
  mode = "sandboxed",
}: SkillReviewSectionProps) {
  const state = useSkillReview(mode);
  return <SkillReviewView state={state} mode={mode} />;
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link SkillReviewState} (no Tauri, no network) and assert the diff display,
 * approve/reject wiring, and gate semantics.
 */
export function SkillReviewView({
  state,
  mode = "sandboxed",
}: {
  state: SkillReviewState;
  mode?: HermesAdminMode;
}) {
  // The write whose full diff is expanded (one at a time).
  const [openWrite, setOpenWrite] = useState<string | null>(null);

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasWrites = state.writes.length > 0;
  const approvableCount = state.writes.filter((write) =>
    canApprove(write),
  ).length;

  return (
    <section
      className="settings-group skill-review"
      aria-labelledby="skill-review-heading"
    >
      <h2 id="skill-review-heading" className="settings-group-heading">
        Pending skill changes
      </h2>
      <p className="settings-group-description">
        Review the skill changes the agent proposes before they land. This is
        how June learns new procedures while keeping you in control.{" "}
        <ModeNote
          mode={state.mode ?? mode}
          profile={state.profile}
          show={!isUnavailable}
        />
      </p>

      <GateCard state={state} />

      <LifecycleBanner state={state} />
      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      <div className="settings-card skill-review-card">
        <div className="skill-review-toolbar">
          <span className="skill-review-toolbar-label">
            {hasWrites
              ? `${state.writes.length} ${state.writes.length === 1 ? "change" : "changes"} to review`
              : "No changes to review"}
          </span>
          <div className="skill-review-toolbar-actions">
            {hasWrites && !isUnavailable ? (
              <>
                <button
                  type="button"
                  className="skill-review-bulk skill-review-bulk-approve"
                  disabled={approvableCount === 0}
                  onClick={state.approveAll}
                >
                  <IconCheckmark1 size={14} ariaHidden />
                  Approve all
                </button>
                <button
                  type="button"
                  className="skill-review-bulk skill-review-bulk-reject"
                  onClick={state.rejectAll}
                >
                  <IconCrossSmall size={14} ariaHidden />
                  Reject all
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="skill-review-refresh"
              disabled={isUnavailable || isLoadingFirst}
              onClick={state.refresh}
            >
              <IconArrowRotateClockwise size={14} ariaHidden />
              Refresh
            </button>
          </div>
        </div>

        {state.error && hasWrites ? (
          <p className="settings-row-error skill-review-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="skill-review-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to review the skill changes the agent has proposed."
            />
          ) : isErrored ? (
            <ErrorState
              message={
                state.error ?? "Could not load pending changes from Hermes."
              }
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isLoadingFirst ? (
            <ReviewLoading />
          ) : !hasWrites ? (
            <EmptyState
              title="Nothing waiting for you"
              description="When the agent proposes a skill change, it will appear here for you to approve or reject."
            />
          ) : (
            <ul className="skill-review-list">
              {state.writes.map((write) => (
                <WriteRow
                  key={write.id}
                  write={write}
                  pending={state.pending.has(write.id)}
                  expanded={openWrite === write.id}
                  onToggleExpand={() =>
                    setOpenWrite((current) =>
                      current === write.id ? null : write.id,
                    )
                  }
                  onApprove={() => state.approve(write.id)}
                  onReject={() => state.reject(write.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** The write-approval gate card: the toggle, the on/off consequence copy, and a
 * sandbox-aware note. */
function GateCard({ state }: { state: SkillReviewState }) {
  if (state.status === "unavailable") return null;
  const enabled = state.gateEnabled === true;
  const known = state.gateEnabled !== undefined;
  return (
    <div className="settings-card skill-review-gate">
      <div className="skill-review-gate-main">
        <span className="skill-review-gate-icon" aria-hidden>
          <IconShieldCheck size={18} />
        </span>
        <div className="skill-review-gate-text">
          <h3 className="skill-review-gate-title" id="skill-review-gate-label">
            Require approval for agent skill writes
          </h3>
          <p className="skill-review-gate-copy">
            {known && !enabled
              ? WRITE_APPROVAL_OFF_COPY
              : WRITE_APPROVAL_ON_COPY}
          </p>
        </div>
      </div>
      <div className="skill-review-gate-control">
        <Switch
          checked={enabled}
          disabled={!known || state.gatePending}
          aria-labelledby="skill-review-gate-label"
          onCheckedChange={state.setGate}
        />
        {state.gatePending ? (
          <span className="skill-review-gate-timing" aria-hidden>
            Saving
          </span>
        ) : (
          <span className="skill-review-gate-timing">Applies next session</span>
        )}
      </div>
    </div>
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
    <span className="skill-review-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner (an approved write applies to new
 * sessions, so the page states that standing). */
function LifecycleBanner({ state }: { state: SkillReviewState }) {
  if (state.status === "unavailable") return null;
  const snapshot = state.lifecycle;
  const clean = snapshot.state === "clean";
  const tone =
    snapshot.state === "restart-failed"
      ? "destructive"
      : snapshot.state === "gateway-restart-required" ||
          snapshot.state === "active-session-should-restart"
        ? "warning"
        : "info";
  const label = clean ? "Applies next session" : snapshot.label;
  const detail = clean
    ? "Approving a change takes effect in new sessions. Current sessions are unaffected."
    : snapshot.detail;
  return (
    <div className="skill-review-lifecycle" data-tone={tone} role="status">
      <span className="skill-review-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {label}
      </span>
      <span className="skill-review-lifecycle-body">{detail}</span>
    </div>
  );
}

/** One pending write: gist headline, op + source provenance pills, affected
 * files, the expandable diff, and approve/reject actions. */
function WriteRow({
  write,
  pending,
  expanded,
  onToggleExpand,
  onApprove,
  onReject,
}: {
  write: PendingSkillWrite;
  pending: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const op = opMeta(write.op);
  const source = writeSourceMeta(write.source);
  const files = affectedFiles(write);
  const redacted = hasRedactedContent(write);
  const approvable = canApprove(write);
  const diffPanelId = `skill-review-diff-${cssId(write.id)}`;

  return (
    <li className="skill-review-row" data-op={write.op}>
      <div className="skill-review-row-main">
        <div className="skill-review-row-headline">
          <span className="skill-review-row-gist">{writeGist(write)}</span>
          <span
            className="skill-review-op"
            data-op={write.op}
            title={op.effect}
          >
            {op.label}
          </span>
          <SourcePill source={write.source} label={source.label} />
        </div>

        <p className="skill-review-row-effect">
          <span className="skill-review-skill-name">{write.skill}</span>{" "}
          {op.effect} {source.blurb}
        </p>

        {files.length > 0 ? (
          <div className="skill-review-files">
            {files.map((path) => (
              <span key={path} className="skill-review-file" title={path}>
                <IconCode size={12} ariaHidden />
                {path}
              </span>
            ))}
          </div>
        ) : null}

        {!approvable && !redacted ? (
          <p className="skill-review-unreadable">
            <IconWarningSign size={13} ariaHidden />
            June could not fully read this change, so it cannot be approved
            here. Reject it, or review it in Hermes.
          </p>
        ) : null}

        {redacted ? (
          <p className="skill-review-redacted">
            <IconWarningSign size={13} ariaHidden />
            Secret looking lines are hidden in the diff below, so this cannot be
            approved here without saving the hidden copy. Reject it, or approve
            it in Hermes.
          </p>
        ) : null}

        {files.length > 0 ? (
          <button
            type="button"
            className="skill-review-diff-toggle"
            aria-expanded={expanded}
            aria-controls={diffPanelId}
            onClick={onToggleExpand}
          >
            {expanded ? "Hide diff" : "View diff"}
          </button>
        ) : null}

        {expanded ? (
          <div className="skill-review-diff" id={diffPanelId}>
            {write.files.map((file) => (
              <FileDiff key={file.relativePath} file={file} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="skill-review-row-actions">
        <button
          type="button"
          className="skill-review-action skill-review-approve"
          disabled={pending || !approvable}
          onClick={onApprove}
        >
          <IconCheckmark1 size={14} ariaHidden />
          Approve
        </button>
        <button
          type="button"
          className="skill-review-action skill-review-reject"
          disabled={pending}
          onClick={onReject}
        >
          <IconCrossSmall size={14} ariaHidden />
          Reject
        </button>
        {pending ? (
          <span className="skill-review-action-timing" aria-hidden>
            Saving
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Renders one file's diff (preferred) or its proposed content. Monospace,
 * line-classed so additions/removals read at a glance. */
function FileDiff({ file }: { file: PendingSkillWriteFile }) {
  return (
    <div className="skill-review-file-diff">
      <div className="skill-review-file-diff-path">{file.relativePath}</div>
      {file.diff ? (
        <pre
          className="skill-review-diff-pre"
          aria-label={`Diff for ${file.relativePath}`}
        >
          {file.diff.split("\n").map((line, index) => (
            <span
              key={index}
              className="skill-review-diff-line"
              data-line={diffLineKind(line)}
            >
              {line === "" ? " " : line}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : file.content ? (
        <pre
          className="skill-review-diff-pre"
          aria-label={`Proposed content for ${file.relativePath}`}
        >
          {file.content}
        </pre>
      ) : (
        <p className="skill-review-diff-empty">
          No content preview. This change removes the file.
        </p>
      )}
    </div>
  );
}

/** Classifies a unified-diff line for styling: added / removed / meta / context. */
function diffLineKind(line: string): "add" | "remove" | "meta" | "context" {
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("@@")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

/** The colored source provenance pill. */
function SourcePill({ source, label }: { source: string; label: string }) {
  const icon =
    source === "background" ? (
      <IconBrain2 size={12} ariaHidden />
    ) : source === "foreground" ? (
      <IconRobot2 size={12} ariaHidden />
    ) : (
      <IconCircleInfo size={12} ariaHidden />
    );
  return (
    <span className="skill-review-source" data-source={source}>
      {icon}
      {label}
    </span>
  );
}

function ReviewLoading() {
  return (
    <ul className="skill-review-list" aria-hidden>
      {[0, 1].map((index) => (
        <li key={index} className="skill-review-row skill-review-skeleton">
          <div className="skill-review-row-main">
            <span className="skill-review-skeleton-line skill-review-skeleton-title" />
            <span className="skill-review-skeleton-line" />
          </div>
        </li>
      ))}
    </ul>
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
    <div className="skill-review-empty" role="status">
      <span className="skill-review-empty-icon" aria-hidden>
        <IconBrain2 size={22} />
      </span>
      <p className="skill-review-empty-title">{title}</p>
      <p className="skill-review-empty-description">{description}</p>
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
    <div className="skill-review-error" role="alert">
      <span className="skill-review-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="skill-review-empty-title">Couldn't load pending changes</p>
      <p className="skill-review-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="skill-review-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A DOM-id-safe slug for `aria-controls` wiring. */
function cssId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
