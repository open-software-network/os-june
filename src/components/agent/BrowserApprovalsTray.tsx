import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  browserApprovalRespond,
  browserApprovalsPending,
  type PendingBrowserApproval,
} from "../../lib/tauri";
import { BrowserApprovalCard } from "./chat-turns/AgentActionCards";

const BROWSER_APPROVALS_CHANGED_EVENT = "clovy://browser-approvals-changed";

/** Shell-owned approval surface because a browser action can park while the
 * user navigates away from the originating session. */
export function BrowserApprovalsTray() {
  const [pending, setPending] = useState<PendingBrowserApproval[]>([]);
  const [submitting, setSubmitting] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setPending(await browserApprovalsPending());
    } catch {
      // Startup and shutdown can briefly leave the native broker unavailable.
    }
  }, []);

  useEffect(() => {
    void refresh();
    let dispose: (() => void) | undefined;
    let stopped = false;
    void listen(BROWSER_APPROVALS_CHANGED_EVENT, () => void refresh()).then((next) => {
      if (stopped) next();
      else dispose = next;
    });
    return () => {
      stopped = true;
      dispose?.();
    };
  }, [refresh]);

  if (pending.length === 0) return null;
  return (
    <aside className="connector-approvals" aria-label="Browser approvals">
      <div className="connector-approvals-list">
        {pending.map((approval) => (
          <BrowserApprovalCard
            key={approval.approvalId}
            approval={approval}
            submitting={submitting === approval.approvalId}
            onRespond={(approve, allowSite) => {
              setSubmitting(approval.approvalId);
              setError(undefined);
              void browserApprovalRespond({
                approvalId: approval.approvalId,
                approve,
                allowSite,
              })
                .catch((cause) => setError(messageFromError(cause)))
                .finally(() => {
                  setSubmitting(undefined);
                  void refresh();
                });
            }}
          />
        ))}
      </div>
      {error ? (
        <p className="connector-approvals-error" role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
