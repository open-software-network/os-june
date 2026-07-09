import { IconChecklist } from "central-icons/IconChecklist";
import { useCallback, useEffect, useRef, useState } from "react";
import { actionToolLabel } from "../../lib/connectors";
import {
  CONNECTOR_APPROVALS_CHANGED_EVENT,
  type PendingConnectorApproval,
  connectorApprovalRespond,
  connectorApprovalsPending,
  connectorApprovalsRespondAll,
} from "../../lib/tauri";

/**
 * Always-mounted surface for connector action calls parked in the Rust proxy
 * under the approval trust mode. A routine (or chat) that tries to send, draft,
 * label, or change a calendar event pauses here until the user approves or
 * denies. Renders nothing when nothing is pending.
 *
 * Batched by design: a triage run can propose several drafts at once, so
 * "Approve all" answers the whole set in one tap. Every item shows the account
 * it touches and a redacted preview (redaction happens in Rust).
 */
export function ConnectorApprovalsTray() {
  const [pending, setPending] = useState<PendingConnectorApproval[]>([]);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await connectorApprovalsPending();
      if (mounted.current) setPending(next);
    } catch {
      // The bridge may not be up yet; the change event will re-drive us.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    let unlisten: (() => void) | undefined;
    let aborted = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen(CONNECTOR_APPROVALS_CHANGED_EVENT, () => void refresh()))
      .then((cleanup) => {
        if (aborted) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      aborted = true;
      unlisten?.();
    };
  }, [refresh]);

  const respondOne = useCallback(
    async (approvalId: string, approve: boolean) => {
      setBusy(true);
      try {
        await connectorApprovalRespond({ approvalId, approve });
      } finally {
        if (mounted.current) setBusy(false);
        void refresh();
      }
    },
    [refresh],
  );

  const respondAll = useCallback(
    async (approve: boolean) => {
      setBusy(true);
      try {
        await connectorApprovalsRespondAll({ approve });
      } finally {
        if (mounted.current) setBusy(false);
        void refresh();
      }
    },
    [refresh],
  );

  if (pending.length === 0) return null;

  return (
    <aside
      className="connector-approvals"
      aria-label="Connector approvals"
      // biome-ignore lint/a11y/useSemanticElements: a status role fits a
      // passive, self-updating queue better than a live region alert.
      role="status"
    >
      <header className="connector-approvals-header">
        <span className="connector-approvals-title">
          <IconChecklist size={16} aria-hidden />
          Approvals needed ({pending.length})
        </span>
        {pending.length > 1 ? (
          <span className="connector-approvals-bulk">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void respondAll(true)}
            >
              Approve all
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void respondAll(false)}
            >
              Deny all
            </button>
          </span>
        ) : null}
      </header>
      <ul className="connector-approvals-list">
        {pending.map((item) => (
          <li key={item.approvalId} className="connector-approvals-item">
            <div className="connector-approvals-info">
              <p className="connector-approvals-summary">
                {item.summary || actionToolLabel(item.tool)}
              </p>
              <p className="connector-approvals-meta">
                {actionToolLabel(item.tool)} · {item.accountEmail}
              </p>
              {item.argsPreview ? (
                <p className="connector-approvals-preview">{item.argsPreview}</p>
              ) : null}
            </div>
            <div className="connector-approvals-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void respondOne(item.approvalId, false)}
              >
                Deny
              </button>
              <button
                type="button"
                className="btn primary-action primary-solid"
                disabled={busy}
                onClick={() => void respondOne(item.approvalId, true)}
              >
                Approve
              </button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
