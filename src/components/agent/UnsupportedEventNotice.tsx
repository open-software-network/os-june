import { IconWarningSign } from "central-icons/IconWarningSign";
import type { UnsupportedEventNoticeData } from "../../lib/hermes-unsupported-events";

/**
 * The user-facing surface for an unsupported Hermes event affecting the active
 * session. Production-safe by construction: the title and body are generic and
 * carry no raw type or payload. Sanitized developer details (type, session id,
 * payload preview) render ONLY in dev builds (`import.meta.env.DEV`); the store
 * has already sanitized the preview, so even those never show secrets.
 *
 * Actions:
 * - "Open raw trace" — shown only when `debugEnabled` (dev/debug). Feature 15
 *   builds the trace panel; until then the parent passes a no-op (see the wiring
 *   note in `AgentWorkspace`). Receives the affected session id.
 * - "Stop session" — recoverable escape hatch (parent wires `stopHermesSession`).
 * - "Report issue" — shown only when `debugEnabled` (dev/debug), alongside
 *   "Open raw trace". There is no real reporting surface in production yet, so
 *   the parent's handler only logs the sanitized trace bundle in dev; gating the
 *   button keeps a shipped build from offering an action that does nothing.
 *
 * Renders nothing when `notice` is undefined, so a session with no unsupported
 * events shows no banner.
 */
export function UnsupportedEventNotice({
  notice,
  debugEnabled,
  onOpenRawTrace,
  onStopSession,
  onReportIssue,
}: {
  notice: UnsupportedEventNoticeData | undefined;
  /** True when dev/debug surfaces are enabled — gates "Open raw trace". */
  debugEnabled: boolean;
  /** Opens the raw trace for the session (feature 15). Optional until wired. */
  onOpenRawTrace?: (sessionId: string) => void;
  onStopSession?: () => void;
  onReportIssue?: () => void;
}) {
  if (!notice) return null;

  // Dev details and the raw-trace affordance both depend on a developer
  // context; the trace button additionally needs a handler to call. "Report
  // issue" is gated the same way: there is no production reporting surface, so
  // the button would be a no-op in a shipped build.
  const showDevDetails = import.meta.env.DEV;
  const showRawTrace = debugEnabled && Boolean(onOpenRawTrace);
  const showReportIssue = debugEnabled && Boolean(onReportIssue);

  return (
    <section
      className="agent-unsupported-notice"
      role="status"
      aria-live="polite"
    >
      <div className="agent-unsupported-notice-icon" aria-hidden="true">
        <IconWarningSign size={16} />
      </div>
      <div className="agent-unsupported-notice-body">
        <p className="agent-unsupported-notice-title">
          June received a Hermes event it does not support yet.
        </p>
        <p className="agent-unsupported-notice-text">
          This session can keep going. If something looks stuck, stop the
          session and try again.
        </p>

        {showDevDetails ? (
          <dl className="agent-unsupported-notice-dev">
            <div>
              <dt>Type</dt>
              <dd>
                <code>{notice.type ?? "(unknown)"}</code>
              </dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>
                <code>{notice.sessionId}</code>
              </dd>
            </div>
            {notice.count > 1 ? (
              <div>
                <dt>Seen</dt>
                <dd>{notice.count} times</dd>
              </div>
            ) : null}
            {notice.payloadPreview ? (
              <div>
                <dt>Sanitized payload</dt>
                <dd>
                  <pre>{notice.payloadPreview}</pre>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        <div className="agent-unsupported-notice-actions">
          {showRawTrace ? (
            <button
              type="button"
              className="agent-unsupported-notice-action"
              onClick={() => onOpenRawTrace?.(notice.sessionId)}
            >
              Open raw trace
            </button>
          ) : null}
          <button
            type="button"
            className="agent-unsupported-notice-action"
            onClick={() => onStopSession?.()}
          >
            Stop session
          </button>
          {showReportIssue ? (
            <button
              type="button"
              className="agent-unsupported-notice-action"
              onClick={() => onReportIssue?.()}
            >
              Report issue
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
