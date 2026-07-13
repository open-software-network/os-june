import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { accessGrantLog, type AccessGrantLog } from "../../lib/access-grant-log";
import { hermesAgentCliAccess, setHermesAgentCliAccess } from "../../lib/tauri";
import {
  buildAllowedCommandRows,
  useAccessGrants,
  type AccessGrantsState,
  type AllowedCommandRow,
  type HermesAdminMode,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";
import { InlineNotice } from "../ui/InlineNotice";
import { SettingsPageHeader } from "./AppSettings";

type AccessGrantsSectionProps = {
  /** The write-access mode whose runtime the allowlist half targets. Defaults
   * to the safe sandboxed runtime; the host can point it at Full mode. */
  mode?: HermesAdminMode;
};

/**
 * June's Access grants manager (JUN-206). One page listing the PERSISTENT
 * grants: app-wide, ongoing permissions that stay in effect until revoked
 * here. One-time and session approvals expire on their own (consumed by the
 * request, or with the session) and are deliberately not listed.
 *
 * - "Always allowed commands": the runtime's persisted `command_allowlist`
 *   (an "Always approve" answer), read and revoked through the same safe REST
 *   config write the External directories page uses.
 * - "Agent CLI access": the app-wide flag granting write access to coding CLI
 *   state folders, revocable here; the Agent settings toggle is the primary
 *   control.
 *
 * Remote data lives in {@link useAccessGrants}; the local grant log (which
 * enriches allowlist rows with when/what granted them) is read synchronously.
 * This component is presentation plus wiring.
 */
export function AccessGrantsSection({ mode = "sandboxed" }: AccessGrantsSectionProps) {
  const state = useAccessGrants(mode);
  const logEntries = useAccessGrantLog(accessGrantLog);

  // Agent CLI access: an app-wide, ongoing grant persisted as a flag file.
  // Read here so the inventory really covers every persistent grant; the
  // toggle in Agent settings remains the primary control.
  const [cliAccess, setCliAccess] = useState<boolean | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    hermesAgentCliAccess()
      .then((status) => {
        if (!cancelled) setCliAccess(status.enabled);
      })
      .catch(() => {
        if (!cancelled) setCliAccess(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const revokeCliAccess = useCallback(async () => {
    setCliBusy(true);
    try {
      const status = await setHermesAgentCliAccess(false);
      setCliAccess(status.enabled);
    } catch {
      // Leave the shown state unchanged; the Agent settings toggle surfaces
      // write failures with full error copy.
    } finally {
      setCliBusy(false);
    }
  }, []);

  return (
    <AccessGrantsView
      state={state}
      allowedRows={buildAllowedCommandRows(state.patterns, logEntries)}
      cliAccess={cliAccess}
      cliBusy={cliBusy}
      onRevokeCliAccess={() => void revokeCliAccess()}
    />
  );
}

/** Binds an {@link AccessGrantLog} to React. Exported for tests. */
export function useAccessGrantLog(log: AccessGrantLog) {
  return useSyncExternalStore(log.subscribe, log.list, log.list);
}

/**
 * The render-only view, split out so component tests can drive it with stubbed
 * state (no Tauri, no network) and assert the labels and the revoke wiring.
 */
export function AccessGrantsView({
  state,
  allowedRows,
  cliAccess,
  cliBusy,
  onRevokeCliAccess,
}: {
  state: AccessGrantsState;
  allowedRows: AllowedCommandRow[];
  /** Whether Agent CLI access is granted; null when the status is unknown. */
  cliAccess: boolean | null;
  cliBusy: boolean;
  onRevokeCliAccess: () => void;
}) {
  const [refreshSpins, setRefreshSpins] = useState(0);
  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoading = state.status === "loading";

  const handleRefresh = () => {
    setRefreshSpins((spins) => spins + 1);
    state.refresh();
  };

  return (
    <section className="settings-group access-grants" aria-labelledby="access-grants-heading">
      <SettingsPageHeader
        id="access-grants-heading"
        title="Access grants"
        blurb="Ongoing permissions you have granted the agent. They apply app-wide until revoked here. One-time and session approvals expire on their own and are not listed."
      />

      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      {/* --- Always allowed commands (lives in the runtime's config, so this
       * group needs the runtime to be reachable) --- */}
      <div className="access-grants-group">
        <div className="access-grants-group-header">
          <h3 className="settings-group-heading">Always allowed commands</h3>
          <button
            type="button"
            className="icon-button access-grants-refresh"
            aria-label="Refresh always allowed commands"
            aria-busy={isLoading || state.busy}
            title="Refresh always allowed commands"
            disabled={isUnavailable || isLoading || state.busy}
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
        <p className="settings-group-description">
          Commands you chose to always approve. They apply app-wide and stay in effect until
          revoked. Revoking applies to new sessions; a matching command will ask for approval again.
        </p>
        <div className="settings-card">
          {state.error && !isErrored ? (
            <p className="settings-row-error access-grants-inline-error">
              <IconExclamationCircle size={14} ariaHidden />
              {state.error}
            </p>
          ) : null}
          {isUnavailable ? (
            <GroupNote text="The agent runtime is not running. Start it to see and revoke always allowed commands." />
          ) : isErrored ? (
            <div className="access-grants-note" role="alert">
              <p>{state.error ?? "Could not load always allowed commands."}</p>
              {state.retryable ? (
                <button type="button" className="btn btn-secondary" onClick={state.refresh}>
                  Try again
                </button>
              ) : null}
            </div>
          ) : isLoading ? (
            <GroupNote text="Loading always allowed commands." />
          ) : allowedRows.length === 0 ? (
            <GroupNote text="No always allowed commands. When you answer an approval with Always approve, it appears here." />
          ) : (
            <ul className="access-grants-list">
              {allowedRows.map((row) => (
                <AllowedCommandItem
                  key={row.pattern}
                  row={row}
                  busy={state.busy}
                  onRevoke={() => state.revoke(row.pattern)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* --- Agent CLI access (app-wide flag; the Agent settings toggle is the
       * primary control, this row keeps the inventory complete) --- */}
      <div className="access-grants-group">
        <h3 className="settings-group-heading">Agent CLI access</h3>
        <p className="settings-group-description">
          Write access to the settings and session folders of coding CLIs you already use, like
          Claude Code and Codex. Also managed under Agent settings. Revoking applies to new
          sessions.
        </p>
        <div className="settings-card">
          {cliAccess === null ? (
            <GroupNote text="Could not read the current status. Manage this grant under Agent settings." />
          ) : cliAccess ? (
            <ul className="access-grants-list">
              <li className="settings-row access-grant-row">
                <div className="settings-row-info">
                  <h4 className="settings-row-title">Coding CLI state folders</h4>
                  <p className="settings-row-description">
                    Applies app-wide and stays in effect until revoked.
                  </p>
                </div>
                <div className="settings-row-control">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={cliBusy}
                    onClick={onRevokeCliAccess}
                  >
                    Revoke
                  </button>
                </div>
              </li>
            </ul>
          ) : (
            <GroupNote text="Not granted." />
          )}
        </div>
      </div>

      <InlineNotice
        tone="info"
        icon={<IconCircleInfo size={15} ariaHidden />}
        body="System permissions like microphone and accessibility are managed under General. MCP server and connector access is managed under MCP servers."
      />
    </section>
  );
}

function AllowedCommandItem({
  row,
  busy,
  onRevoke,
}: {
  row: AllowedCommandRow;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="settings-row access-grant-row">
      <div className="settings-row-info">
        <h4 className="settings-row-title">{row.pattern}</h4>
        {row.command ? (
          <p className="settings-row-description access-grant-command" title={row.command}>
            {row.command}
          </p>
        ) : null}
        {row.grantedAt ? (
          <p className="settings-row-description">
            <span className="access-grant-when">Granted {formatGrantedAt(row.grantedAt)}</span>
          </p>
        ) : null}
      </div>
      <div className="settings-row-control">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRevoke}>
          Revoke
        </button>
      </div>
    </li>
  );
}

function GroupNote({ text }: { text: string }) {
  return (
    <p className="access-grants-note" role="status">
      {text}
    </p>
  );
}

function formatGrantedAt(grantedAt: number): string {
  try {
    return new Date(grantedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "recently";
  }
}
