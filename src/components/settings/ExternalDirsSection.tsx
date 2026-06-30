import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconFolderShared } from "central-icons/IconFolderShared";
import { IconLock } from "central-icons/IconLock";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useState } from "react";
import {
  presenceMeta,
  shadowingExplanation,
  useExternalDirs,
  writabilityMeta,
  sharedDirWarning,
  type ExternalDirRow,
  type ExternalDirsState,
  type HermesAdminMode,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";

type ExternalDirsSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the
   * safe sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native External skill directories manager (spec 10). Lists the
 * directories configured under `skills.external_dirs` for the targeted profile
 * and, for each, shows the raw + resolved path, exists/readable/writable status,
 * the discovered-skill count, whether a local skill shadows its skills, and the
 * standing fact that June treats external-directory skills as read-only. Lets a
 * user add/remove directories through a safe REST config write (the jailed
 * Hermes dashboard owns the config.yaml write).
 *
 * Data lives entirely in {@link useExternalDirs}; this component is presentation
 * + the local add-form input state.
 */
export function ExternalDirsSection({
  mode = "sandboxed",
}: ExternalDirsSectionProps) {
  const state = useExternalDirs(mode);
  return <ExternalDirsView state={state} mode={mode} />;
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link ExternalDirsState} (no Tauri, no network) and assert the labels and the
 * add/remove wiring.
 */
export function ExternalDirsView({
  state,
  mode = "sandboxed",
}: {
  state: ExternalDirsState;
  mode?: HermesAdminMode;
}) {
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState<string>();

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasRows = state.rows.length > 0;

  const submit = async () => {
    setFormError(undefined);
    const reason = await state.add(draft);
    if (reason) {
      setFormError(reason);
      return;
    }
    setDraft("");
  };

  return (
    <section
      className="settings-group external-dirs"
      aria-labelledby="external-dirs-heading"
    >
      <h2 id="external-dirs-heading" className="settings-group-heading">
        External skill directories
      </h2>
      <p className="settings-group-description">
        Shared folders Hermes scans for skills alongside your installed skills.
        Changes apply to new sessions.{" "}
        <ModeNote
          mode={state.mode ?? mode}
          profile={state.profile}
          show={!isUnavailable}
        />
      </p>

      <LifecycleBanner state={state} />

      <div className="external-dirs-warning" role="note">
        <IconWarningSign size={15} ariaHidden />
        <span>{sharedDirWarning(state.mode ?? mode)}</span>
      </div>

      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      <div className="settings-card external-dirs-card">
        <div className="external-dirs-toolbar">
          <div className="external-dirs-add">
            <input
              type="text"
              value={draft}
              placeholder="Add a directory path"
              aria-label="External directory path"
              disabled={isUnavailable || state.busy}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                if (formError) setFormError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              type="button"
              className="external-dirs-add-button"
              disabled={
                isUnavailable || state.busy || draft.trim().length === 0
              }
              onClick={() => void submit()}
            >
              Add
            </button>
          </div>
          <button
            type="button"
            className="external-dirs-refresh"
            disabled={isUnavailable || isLoadingFirst || state.busy}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Refresh
          </button>
        </div>

        <p className="external-dirs-hint">
          Paths can use {"~"} for your home folder and {"${VAR}"} for
          environment variables. June shows the resolved path below each entry.
        </p>

        {formError ? (
          <p className="settings-row-error external-dirs-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {formError}
          </p>
        ) : null}
        {state.error && hasRows ? (
          <p className="settings-row-error external-dirs-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="external-dirs-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to see and manage the external skill directories for your sessions."
            />
          ) : isErrored ? (
            <ErrorState
              message={state.error ?? "Could not load external directories."}
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isLoadingFirst ? (
            <Loading />
          ) : !hasRows ? (
            <EmptyState
              title="No external directories"
              description="Add a folder of shared skills to load them alongside your installed skills."
            />
          ) : (
            <ul className="external-dirs-list">
              {state.rows.map((row) => (
                <DirRow
                  key={row.rawPath}
                  row={row}
                  mode={state.mode ?? mode}
                  busy={state.busy}
                  onRemove={() => state.remove(row.rawPath)}
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
    <span className="external-dirs-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner. Always shown: every config change
 * applies to new sessions, so the page states that standing. */
function LifecycleBanner({ state }: { state: ExternalDirsState }) {
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
    ? "Your changes take effect in new sessions. Current sessions are unaffected."
    : snapshot.detail;
  return (
    <div className="external-dirs-lifecycle" data-tone={tone} role="status">
      <span className="external-dirs-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {label}
      </span>
      <span className="external-dirs-lifecycle-body">{detail}</span>
    </div>
  );
}

/** One directory row: raw + resolved paths, presence/writability/skill-count
 * status, shadowing explanation, the read-only-in-June note, and a remove
 * action. */
function DirRow({
  row,
  mode,
  busy,
  onRemove,
}: {
  row: ExternalDirRow;
  mode: HermesAdminMode;
  busy: boolean;
  onRemove: () => void;
}) {
  const presence = presenceMeta(row.presence);
  const writability = writabilityMeta(row.writability, mode);
  const shadowing = shadowingExplanation(row);

  return (
    <li className="external-dir-row">
      <div className="external-dir-main">
        <div className="external-dir-headline">
          <span className="external-dir-icon" aria-hidden>
            <IconFolderShared size={16} />
          </span>
          <span className="external-dir-path" title={row.rawPath}>
            {row.rawPath}
          </span>
          <span className="external-dir-status" data-tone={presence.tone}>
            {presence.label}
          </span>
          <span className="external-dir-status" data-tone={writability.tone}>
            {writability.label}
          </span>
        </div>

        {row.expanded && row.resolvedPath ? (
          <p className="external-dir-resolved" title={row.resolvedPath}>
            Resolves to {row.resolvedPath}
          </p>
        ) : null}

        {row.presence === "unresolved" && row.unresolvedVar ? (
          <p className="external-dir-note external-dir-note-warning">
            Set the {row.unresolvedVar} environment variable to resolve this
            path.
          </p>
        ) : null}

        <div className="external-dir-meta">
          {typeof row.skillCount === "number" ? (
            <span className="external-dir-meta-item">
              {row.skillCount === 1
                ? "1 skill found"
                : `${row.skillCount} skills found`}
            </span>
          ) : row.presence === "missing" ? (
            <span className="external-dir-meta-item">
              No skills loaded (directory not found)
            </span>
          ) : null}
          <span
            className="external-dir-readonly"
            title="June does not edit external skills."
          >
            <IconLock size={12} ariaHidden />
            Read only in June
          </span>
        </div>

        {shadowing ? <p className="external-dir-note">{shadowing}</p> : null}
      </div>

      <div className="external-dir-actions">
        <button
          type="button"
          className="external-dir-remove"
          aria-label={`Remove ${row.rawPath}`}
          title="Remove directory"
          disabled={busy}
          onClick={onRemove}
        >
          <IconCrossSmall size={14} ariaHidden />
        </button>
      </div>
    </li>
  );
}

function Loading() {
  return (
    <ul className="external-dirs-list" aria-hidden>
      {[0, 1].map((index) => (
        <li key={index} className="external-dir-row external-dir-skeleton">
          <div className="external-dir-main">
            <span className="external-dir-skeleton-line external-dir-skeleton-title" />
            <span className="external-dir-skeleton-line" />
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
    <div className="external-dirs-empty" role="status">
      <span className="external-dirs-empty-icon" aria-hidden>
        <IconFolderShared size={22} />
      </span>
      <p className="external-dirs-empty-title">{title}</p>
      <p className="external-dirs-empty-description">{description}</p>
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
    <div className="external-dirs-error" role="alert">
      <span className="external-dirs-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="external-dirs-empty-title">Couldn't load directories</p>
      <p className="external-dirs-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="external-dirs-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
