import { useMemo, useState, useSyncExternalStore } from "react";
import { IconConsole } from "central-icons/IconConsole";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import type {
  HermesTraceBuffer,
  HermesTraceEntry,
} from "../../lib/hermes-trace-buffer";
import type { JuneHermesEventKind } from "../../lib/hermes-control-plane";

/**
 * Dev/debug-only inspector for the raw Hermes wire (feature 15). Renders the
 * chronological {@link HermesTraceBuffer} for a session: each inbound frame with
 * its raw type and normalized kind, each outbound method call, and each error.
 *
 * Gated to dev/debug builds: returns `null` in production (`import.meta.env.DEV`
 * is false) so the panel and its export affordance never ship to users. The
 * buffer it reads is already sanitized — keys and a capped, secret-masked
 * preview only — so even the copy/export action cannot leak a token.
 *
 * The panel is a controlled overlay: the parent owns `open` and which
 * `sessionId` it opened for (e.g. from the unsupported-event notice's "Open raw
 * trace"); the session filter starts there but the developer can switch it or
 * filter by event kind from inside the panel.
 */
export function HermesTracePanel({
  buffer,
  open,
  sessionId,
  onClose,
}: {
  buffer: HermesTraceBuffer;
  open: boolean;
  /** The session the panel was opened for; seeds the session filter. */
  sessionId?: string;
  onClose: () => void;
}) {
  // Subscribe to the buffer so new frames re-render the list live. Hooks must
  // run unconditionally, so this sits above the dev/open guards below.
  const version = useSyncExternalStore(
    buffer.subscribe,
    buffer.getVersion,
    buffer.getVersion,
  );

  const [sessionFilter, setSessionFilter] = useState<string | undefined>(
    sessionId,
  );
  const [kindFilter, setKindFilter] = useState<TraceKindFilter>("all");

  const sessionIds = useMemo(
    // `version` is the change signal; the buffer read returns live state.
    () => buffer.sessionIds(),
    [buffer, version],
  );

  // Default the filter to the opened session, falling back to the first known
  // session so the panel isn't empty when opened without an explicit one.
  const activeSession = sessionFilter ?? sessionId ?? sessionIds[0];

  const entries = useMemo(
    () => buffer.entriesFor(activeSession),
    [buffer, activeSession, version],
  );

  const visibleEntries = useMemo(
    () => entries.filter((entry) => matchesKind(entry, kindFilter)),
    [entries, kindFilter],
  );

  // Dev gate AND open gate after hooks so render is unconditional above.
  if (!import.meta.env.DEV) return null;
  if (!open) return null;

  async function copyTrace(): Promise<void> {
    const bundle = buffer.exportSanitizedTrace(activeSession);
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    } catch {
      // Clipboard can reject (permissions, headless); a dev tool swallows it.
    }
  }

  return (
    <section
      className="hermes-trace-panel"
      role="dialog"
      aria-label="Raw Hermes trace"
    >
      <header className="hermes-trace-panel-header">
        <div className="hermes-trace-panel-title">
          <IconConsole size={16} aria-hidden="true" />
          <span>Raw Hermes trace</span>
        </div>
        <div className="hermes-trace-panel-controls">
          <label className="hermes-trace-panel-field">
            <span>Filter by session</span>
            <select
              value={activeSession ?? ""}
              onChange={(event) =>
                setSessionFilter(event.target.value || undefined)
              }
            >
              {sessionIds.length === 0 ? (
                <option value="">No sessions</option>
              ) : (
                sessionIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="hermes-trace-panel-field">
            <span>Filter by kind</span>
            <select
              value={kindFilter}
              onChange={(event) =>
                setKindFilter(event.target.value as TraceKindFilter)
              }
            >
              {KIND_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="hermes-trace-panel-button"
            onClick={() => void copyTrace()}
          >
            <IconArrowInbox size={14} aria-hidden="true" />
            Copy trace
          </button>
          <button
            type="button"
            className="hermes-trace-panel-button hermes-trace-panel-close"
            aria-label="Close raw trace"
            onClick={onClose}
          >
            <IconCrossMedium size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <p className="hermes-trace-panel-note">
        Sanitized for safe sharing. Secret-like values are masked; this view is
        dev only.
      </p>

      {visibleEntries.length === 0 ? (
        <p className="hermes-trace-panel-empty">
          No trace entries for this session yet.
        </p>
      ) : (
        <ol className="hermes-trace-panel-list">
          {visibleEntries.map((entry) => (
            <TraceRow key={entry.id} entry={entry} />
          ))}
        </ol>
      )}
    </section>
  );
}

function TraceRow({ entry }: { entry: HermesTraceEntry }) {
  const unsupported = entry.normalizedKind === "unsupported";
  return (
    <li
      className="hermes-trace-row"
      data-direction={entry.direction}
      data-unsupported={unsupported ? "true" : undefined}
    >
      <div className="hermes-trace-row-head">
        <span className="hermes-trace-row-direction">{entry.direction}</span>
        {entry.rawType ? (
          <code className="hermes-trace-row-type">{entry.rawType}</code>
        ) : null}
        {entry.method ? (
          <code className="hermes-trace-row-type">{entry.method}</code>
        ) : null}
        {entry.normalizedKind ? (
          <span className="hermes-trace-row-kind">{entry.normalizedKind}</span>
        ) : null}
        <time className="hermes-trace-row-time">{entry.observedAt}</time>
      </div>
      {entry.message ? (
        <p className="hermes-trace-row-message">{entry.message}</p>
      ) : null}
      {entry.payloadPreview ? (
        <pre className="hermes-trace-row-payload">{entry.payloadPreview}</pre>
      ) : null}
    </li>
  );
}

/** The kind selector value: any normalized event kind, plus an "all" sentinel. */
type TraceKindFilter = "all" | JuneHermesEventKind;

const KIND_FILTERS: { value: TraceKindFilter; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "transcript", label: "Transcript" },
  { value: "reasoning", label: "Reasoning" },
  { value: "tool", label: "Tool" },
  { value: "pending_action", label: "Pending action" },
  { value: "background_activity", label: "Background activity" },
  { value: "lifecycle", label: "Lifecycle" },
  { value: "error", label: "Error" },
  { value: "unsupported", label: "Unsupported" },
];

/** Whether an entry passes the kind filter. Outbound/error entries (which have
 * no `normalizedKind`) only show under "all" — the kind filter targets the
 * normalized inbound stream. */
function matchesKind(
  entry: HermesTraceEntry,
  filter: TraceKindFilter,
): boolean {
  if (filter === "all") return true;
  return entry.normalizedKind === filter;
}
