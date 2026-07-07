import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconBuildingBlocks } from "central-icons/IconBuildingBlocks";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconFolderOpen } from "central-icons/IconFolderOpen";
import { IconFolderShared } from "central-icons/IconFolderShared";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  presenceMeta,
  shadowingExplanation,
  useExternalDirs,
  sharedDirWarning,
  type ExternalDirRow,
  type ExternalDirsState,
  type HermesAdminMode,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";
import { Dialog, DialogField } from "../ui/Dialog";
import { InlineNotice } from "../ui/InlineNotice";
import { SettingsPageHeader } from "./AppSettings";

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
export function ExternalDirsSection({ mode = "sandboxed" }: ExternalDirsSectionProps) {
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
  const [addOpen, setAddOpen] = useState(false);
  const [refreshSpins, setRefreshSpins] = useState(0);
  // Which row is disclosed (one at a time). Keyed by the raw configured path,
  // the row identity. Local to the view: the state layer owns no expansion.
  const [openPath, setOpenPath] = useState<string>();

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasRows = state.rows.length > 0;

  const handleRefresh = () => {
    setRefreshSpins((spins) => spins + 1);
    state.refresh();
  };

  return (
    <section className="settings-group external-dirs" aria-labelledby="external-dirs-heading">
      <SettingsPageHeader
        id="external-dirs-heading"
        title="External skill directories"
        blurb={
          <>
            Shared folders Hermes scans for skills alongside your installed skills. June never edits
            external skills; they are read only. Changes apply to new sessions.{" "}
            <ModeNote mode={state.mode ?? mode} profile={state.profile} show={!isUnavailable} />
          </>
        }
      />

      <LifecycleBanner state={state} />

      <InlineNotice
        tone="warning"
        icon={<IconWarningSign size={15} ariaHidden />}
        body={sharedDirWarning(state.mode ?? mode)}
      />

      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      {/* The action row above the card: add-directory (opens a dialog) + refresh,
       * mirroring the other AI panels. The raw path input now lives in the
       * dialog, not inline in the toolbar. */}
      <div className="external-dirs-actions">
        <button
          type="button"
          className="btn btn-secondary external-dirs-add"
          disabled={isUnavailable || state.busy}
          onClick={() => setAddOpen(true)}
        >
          <IconPlusMedium size={14} ariaHidden />
          Add directory
        </button>
        <button
          type="button"
          className="icon-button external-dirs-refresh"
          aria-label="Refresh external directories"
          aria-busy={isLoadingFirst || state.busy}
          title="Refresh external directories"
          disabled={isUnavailable || isLoadingFirst || state.busy}
          onClick={handleRefresh}
        >
          <IconArrowRotateClockwise
            size={14}
            ariaHidden
            className="balance-refresh-icon"
            style={{ transform: `rotate(${refreshSpins * 360}deg)` }}
          />
        </button>
      </div>

      <AddDirectoryDialog
        open={addOpen}
        busy={state.busy}
        onClose={() => setAddOpen(false)}
        onAdd={(path) => state.add(path)}
      />

      <div className="settings-card external-dirs-card">
        {state.error && hasRows ? (
          <p className="settings-row-error external-dirs-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

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
                busy={state.busy}
                open={openPath === row.rawPath}
                onToggle={() =>
                  setOpenPath((current) => (current === row.rawPath ? undefined : row.rawPath))
                }
                onRemove={() => state.remove(row.rawPath)}
              />
            ))}
          </ul>
        )}
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
  // Render through the shared InlineNotice so the lifecycle banner and the
  // shared-directory warning below it read as one system.
  const noticeTone = tone === "info" ? "info" : tone === "destructive" ? "destructive" : "warning";
  return (
    <InlineNotice
      className="external-dirs-lifecycle"
      tone={noticeTone}
      icon={<IconCircleInfo size={15} ariaHidden />}
      eyebrow={label}
      body={detail}
    />
  );
}

/** One directory row: raw + resolved paths, presence/writability/skill-count
 * status, shadowing explanation, the read-only-in-June note, and a remove
 * action. */
/** The last path segment, for the row's primary label; the full raw path stays
 * in the muted secondary slot and the expanded view. */
function dirBasename(rawPath: string): string {
  const segments = rawPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? rawPath;
}

/** The badge for a directory: healthy (`ok`) rows carry NO badge; only problem
 * states are flagged. Missing reads "Missing"; an unresolved variable reads
 * "Needs variable"; the remaining problem states use their presence label. */
function dirBadge(row: ExternalDirRow): { label: string; tone: "info" | "warning" } | null {
  if (row.presence === "ok") return null;
  if (row.presence === "missing") return { label: "Missing", tone: "warning" };
  if (row.presence === "unresolved") return { label: "Needs variable", tone: "warning" };
  return { label: presenceMeta(row.presence).label, tone: "warning" };
}

function DirRow({
  row,
  busy,
  open,
  onToggle,
  onRemove,
}: {
  row: ExternalDirRow;
  busy: boolean;
  /** Whether this row's expanded details are showing (one at a time, host-owned). */
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const shadowing = shadowingExplanation(row);
  const name = dirBasename(row.rawPath);
  const badge = dirBadge(row);
  const showResolved = Boolean(row.resolvedPath && row.resolvedPath !== row.rawPath);

  return (
    <li className="external-dir-row" data-open={open || undefined}>
      <button
        type="button"
        className="external-dir-summary"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="external-dir-icon" aria-hidden>
          <IconBuildingBlocks size={16} />
        </span>
        <span className="external-dir-copy">
          <span className="external-dir-name-row">
            <span className="external-dir-name">{name}</span>
            {typeof row.skillCount === "number" ? (
              <span className="external-dir-count" aria-label={`${row.skillCount} skills`}>
                ({row.skillCount})
              </span>
            ) : null}
          </span>
          <span className="external-dir-path" title={row.rawPath}>
            {row.rawPath}
          </span>
        </span>
        {badge ? (
          <span className="external-dir-status" data-tone={badge.tone}>
            {badge.label}
          </span>
        ) : null}
        <IconChevronRightSmall size={12} aria-hidden className="external-dir-chevron" />
      </button>

      {open ? (
        <div className="external-dir-details">
          {showResolved ? (
            <p className="external-dir-resolved" title={row.resolvedPath}>
              Resolves to {row.resolvedPath}
            </p>
          ) : null}

          {row.presence === "unresolved" && row.unresolvedVar ? (
            <p className="external-dir-note external-dir-note-warning">
              Set the {row.unresolvedVar} environment variable to resolve this path.
            </p>
          ) : null}

          {row.presence === "missing" ? (
            <div className="external-dir-meta">
              <span className="external-dir-meta-item">No skills loaded (directory not found)</span>
            </div>
          ) : null}

          {shadowing ? <p className="external-dir-note">{shadowing}</p> : null}

          <div className="external-dir-actions">
            <button
              type="button"
              className="external-dir-remove"
              disabled={busy}
              onClick={onRemove}
            >
              Remove directory
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** The add-directory dialog (spec 10 add flow surfaced as a modal): one path
 * input with the ~ / ${VAR} hint as its description, a native folder picker
 * affordance, and Cancel + Add. Validation failures render in the dialog. */
function AddDirectoryDialog({
  open,
  busy,
  onClose,
  onAdd,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  /** Adds the path; resolves to a reason string on failure, or undefined on
   * success. */
  onAdd: (path: string) => Promise<string | undefined>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();

  function handleClose() {
    if (busy) return;
    setDraft("");
    setError(undefined);
    onClose();
  }

  async function handleSubmit() {
    const reason = await onAdd(draft);
    if (reason) {
      setError(reason);
      return;
    }
    setDraft("");
    setError(undefined);
    onClose();
  }

  async function handleChooseFolder() {
    try {
      const picked = await openFileDialog({ directory: true, multiple: false });
      if (typeof picked === "string") {
        setDraft(picked);
        setError(undefined);
      }
    } catch {
      // The native picker failing (or being cancelled) is not an error the user
      // needs to see; they can still type a path.
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Add skill directory"
      width={480}
      footer={
        <>
          <button type="button" className="primary-action" onClick={handleClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void handleSubmit()}
            disabled={busy || draft.trim().length === 0}
          >
            {busy ? "Adding" : "Add"}
          </button>
        </>
      }
    >
      <DialogField
        label="Directory path"
        htmlFor="external-dir-path"
        hint={
          <>
            Use {"~"} for your home folder and {"${VAR}"} for environment variables.
          </>
        }
      >
        <div className="external-dirs-path-field">
          <input
            id="external-dir-path"
            type="text"
            className="dialog-input external-dirs-path-input"
            value={draft}
            placeholder="~/shared-skills"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            disabled={busy}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              if (error) setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim().length > 0) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />
          <button
            type="button"
            className="external-dirs-choose"
            disabled={busy}
            onClick={() => void handleChooseFolder()}
          >
            <IconFolderOpen size={14} ariaHidden />
            Choose folder
          </button>
        </div>
      </DialogField>
      {error ? (
        <p className="settings-row-error external-dirs-dialog-error" role="alert">
          <IconExclamationCircle size={14} ariaHidden />
          {error}
        </p>
      ) : null}
    </Dialog>
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

function EmptyState({ title, description }: { title: string; description: string }) {
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
