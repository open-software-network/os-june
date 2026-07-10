import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { useCallback, useState, useSyncExternalStore } from "react";
import { accessGrantLog, type AccessGrantLog } from "../../lib/access-grant-log";
import { forgetSessionMode, unrestrictedSessionIds } from "../../lib/agent-session-modes";
import {
  buildAllowedCommandRows,
  buildSessionGrantRows,
  grantDurationLabel,
  grantScopeLabel,
  shortSessionId,
  useAccessGrants,
  type AccessGrantsState,
  type AllowedCommandRow,
  type HermesAdminMode,
  type SessionGrantRow,
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
 * June's Access grants manager (JUN-206). One page listing everything the user
 * has granted the agent, with the scope (this session vs app-wide) and duration
 * (one time vs ongoing) of each grant, and the ability to revoke:
 *
 * - "Always allowed commands": the runtime's persisted `command_allowlist`
 *   (an "Always approve" answer), read and revoked through the same safe REST
 *   config write the External directories page uses. App-wide, ongoing.
 * - "Session approvals": June's local log of "Approve once" / "Approve for
 *   this session" answers. Session-scoped; a session approval expires with its
 *   session, a one-time approval was consumed by the request that asked.
 * - "Full access sessions": sessions switched to Unrestricted (no sandbox).
 *   Revoking returns the session to the sandbox on its next message.
 *
 * Remote data lives in {@link useAccessGrants}; the local log and session-mode
 * store are read synchronously. This component is presentation plus wiring.
 */
export function AccessGrantsSection({ mode = "sandboxed" }: AccessGrantsSectionProps) {
  const state = useAccessGrants(mode);
  const log = useAccessGrantLog(accessGrantLog);
  const [unrestricted, setUnrestricted] = useState<string[]>(() => unrestrictedSessionIds());

  const revokeUnrestricted = useCallback((sessionId: string) => {
    forgetSessionMode(sessionId);
    setUnrestricted(unrestrictedSessionIds());
  }, []);

  const grantRows = buildSessionGrantRows(log.entries);
  // Clear only the records the list shows. "always" log entries are invisible
  // here (their live representation is the allowlist row) and clearing them
  // would only strip the granted-when/what enrichment off those rows.
  const clearAllGrants = useCallback(() => {
    for (const row of buildSessionGrantRows(accessGrantLog.list())) {
      accessGrantLog.remove(row.id);
    }
  }, []);

  return (
    <AccessGrantsView
      state={state}
      grantRows={grantRows}
      allowedRows={buildAllowedCommandRows(state.patterns, log.entries)}
      unrestrictedSessions={unrestricted}
      onClearGrant={log.remove}
      onClearAllGrants={clearAllGrants}
      onRevokeUnrestricted={revokeUnrestricted}
    />
  );
}

/** Binds an {@link AccessGrantLog} to React. Exported for tests. */
export function useAccessGrantLog(log: AccessGrantLog) {
  const entries = useSyncExternalStore(log.subscribe, log.list, log.list);
  const remove = useCallback((id: string) => log.remove(id), [log]);
  const clear = useCallback(() => log.clear(), [log]);
  return { entries, remove, clear };
}

/**
 * The render-only view, split out so component tests can drive it with stubbed
 * state (no Tauri, no network) and assert the labels and the revoke wiring.
 */
export function AccessGrantsView({
  state,
  allowedRows,
  grantRows,
  unrestrictedSessions,
  onClearGrant,
  onClearAllGrants,
  onRevokeUnrestricted,
}: {
  state: AccessGrantsState;
  allowedRows: AllowedCommandRow[];
  grantRows: SessionGrantRow[];
  unrestrictedSessions: string[];
  onClearGrant: (id: string) => void;
  onClearAllGrants: () => void;
  onRevokeUnrestricted: (sessionId: string) => void;
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
        blurb="Everything you have granted the agent, with the scope and duration of each grant. Revoke a grant here to take it back."
      />

      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      {/* --- Always allowed commands (app-wide, ongoing; lives in the runtime's
       * config, so this group needs the runtime to be reachable) --- */}
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

      {/* --- Session approvals (June's local record) --- */}
      <div className="access-grants-group">
        <div className="access-grants-group-header">
          <h3 className="settings-group-heading">Session approvals</h3>
          {grantRows.length > 0 ? (
            <button type="button" className="btn btn-secondary" onClick={onClearAllGrants}>
              Clear all
            </button>
          ) : null}
        </div>
        <p className="settings-group-description">
          Approvals you granted for a single request or for the rest of a session. A session
          approval expires when its session ends; a one-time approval covered only the request that
          asked. Clearing a record removes it from this list only.
        </p>
        <div className="settings-card">
          {grantRows.length === 0 ? (
            <GroupNote text="No recorded session approvals." />
          ) : (
            <ul className="access-grants-list">
              {grantRows.map((row) => (
                <SessionGrantItem key={row.id} row={row} onClear={() => onClearGrant(row.id)} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* --- Full access sessions (Unrestricted opt-ins) --- */}
      <div className="access-grants-group">
        <h3 className="settings-group-heading">Full access sessions</h3>
        <p className="settings-group-description">
          Sessions you switched to full access, which runs without the sandbox. Revoking returns the
          session to the sandbox the next time you send a message in it.
        </p>
        <div className="settings-card">
          {unrestrictedSessions.length === 0 ? (
            <GroupNote text="No sessions have full access." />
          ) : (
            <ul className="access-grants-list">
              {unrestrictedSessions.map((sessionId) => (
                <li key={sessionId} className="settings-row access-grant-row">
                  <div className="settings-row-info">
                    <h4 className="settings-row-title">Session {shortSessionId(sessionId)}</h4>
                    <p className="settings-row-description">
                      <GrantBadges scope="session" duration="ongoing" />
                    </p>
                  </div>
                  <div className="settings-row-control">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => onRevokeUnrestricted(sessionId)}
                    >
                      Revoke
                    </button>
                  </div>
                </li>
              ))}
            </ul>
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
        <p className="settings-row-description">
          <GrantBadges scope={row.scope} duration={row.duration} />
          {row.grantedAt ? (
            <span className="access-grant-when">Granted {formatGrantedAt(row.grantedAt)}</span>
          ) : null}
        </p>
      </div>
      <div className="settings-row-control">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRevoke}>
          Revoke
        </button>
      </div>
    </li>
  );
}

function SessionGrantItem({ row, onClear }: { row: SessionGrantRow; onClear: () => void }) {
  return (
    <li className="settings-row access-grant-row">
      <div className="settings-row-info">
        <h4 className="settings-row-title">{row.title}</h4>
        {row.command && row.command !== row.title ? (
          <p className="settings-row-description access-grant-command" title={row.command}>
            {row.command}
          </p>
        ) : null}
        <p className="settings-row-description">
          <GrantBadges scope={row.scope} duration={row.duration} />
          <span className="access-grant-when">
            Session {shortSessionId(row.sessionId)}, granted {formatGrantedAt(row.grantedAt)}
          </span>
        </p>
      </div>
      <div className="settings-row-control">
        <button type="button" className="btn btn-secondary" onClick={onClear}>
          Clear
        </button>
      </div>
    </li>
  );
}

/** The scope + duration pills every row carries, so the two JUN-206 dimensions
 * read consistently across the groups. */
function GrantBadges({
  scope,
  duration,
}: {
  scope: AllowedCommandRow["scope"] | SessionGrantRow["scope"];
  duration: AllowedCommandRow["duration"] | SessionGrantRow["duration"];
}) {
  return (
    <span className="access-grant-badges">
      <span className="status-pill">{grantScopeLabel(scope)}</span>
      <span className="status-pill">{grantDurationLabel(duration)}</span>
    </span>
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
