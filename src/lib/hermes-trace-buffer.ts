/**
 * Bounded, per-session trace of the live Hermes wire — the data source behind
 * feature 15's dev/debug trace panel and its issue-report export.
 *
 * Unlike `hermes-unsupported-events.ts` (which keeps only the events June can't
 * model yet, aggregated by type), this buffer is a *chronological* record of
 * everything that crossed the gateway for a session: each inbound frame paired
 * with the {@link JuneHermesEvent} it classified to, each outbound method call,
 * and each error/rejection. It exists so a developer can reconstruct exactly
 * what happened during a session and attach a secrets-free copy to a bug report.
 *
 * Safety: nothing raw is ever stored. Every payload — inbound or outbound — is
 * run through {@link sanitizePayload} before it lands in an entry, and the
 * preview is derived from the sanitized value (never `JSON.stringify` of the raw
 * frame). Secret-like values are masked at any depth (see
 * `hermes-control-plane/sanitize.ts`). The export shape carries the same already-
 * sanitized fields, so an export can never leak a token an inbound frame
 * happened to include.
 *
 * Framework-agnostic (no React) so tests drive it directly; AgentWorkspace
 * adapts it with a `useSyncExternalStore` wrapper, mirroring feature 02.
 */

import type { HermesGatewayEvent } from "./hermes-gateway";
import {
  classifyHermesEvent,
  nonEmpty,
  sanitizePayload,
  type JuneHermesEvent,
  type JuneHermesEventKind,
} from "./hermes-control-plane";

/**
 * Per-session cap on chronological trace entries kept in memory. Mirrors the
 * `.slice(-200)` cap AgentWorkspace already applies to its raw `liveEvents`
 * ring; once exceeded the oldest entry is dropped.
 */
export const TRACE_ENTRIES_PER_SESSION_CAP = 200;

/** Stable bucket key for frames that arrive without a session id. */
const NO_SESSION_KEY = "__no_session__";

/** Cap on a sanitized preview string so a single entry stays small in an export. */
const PREVIEW_MAX_LENGTH = 2000;

/** Which way a trace entry crossed the gateway. */
export type HermesTraceDirection = "inbound" | "outbound" | "error";

/**
 * One chronological trace entry. Production-safe by construction: `payloadKeys`
 * lists top-level keys (triage signal) and `payloadPreview` is a sanitized,
 * length-capped JSON string. No raw payload, no secret value, ever.
 */
export type HermesTraceEntry = {
  /** Monotonic id within the buffer; stable React key for the panel. */
  id: number;
  direction: HermesTraceDirection;
  observedAt: string;
  sessionId?: string;
  /** Inbound only: the raw wire `type`. */
  rawType?: string;
  /** Inbound only: the kind the classifier mapped the frame to. */
  normalizedKind?: JuneHermesEventKind;
  /** Outbound/error only: the JSON-RPC method involved. */
  method?: string;
  /** Error only: the (already user-safe) error message. */
  message?: string;
  /** Top-level keys of the sanitized payload/params, for quick triage. */
  payloadKeys: string[];
  /** Sanitized, capped JSON preview of the payload/params. */
  payloadPreview?: string;
};

/** A secrets-free bundle for one session, suitable to attach to an issue report. */
export type SanitizedTraceBundle = {
  sessionId?: string;
  exportedAt: string;
  entries: HermesTraceEntry[];
};

/** Inbound recording takes the raw gateway frame and classifies it internally. */
export type InboundTraceInput = HermesGatewayEvent;

/** Outbound recording: the typed method call that was sent to the gateway. */
export type OutboundTraceInput = {
  sessionId?: string;
  method: string;
  params?: unknown;
};

/** Error recording: a rejection/error tied (when known) to a method/session. */
export type ErrorTraceInput = {
  sessionId?: string;
  method?: string;
  message: string;
};

export type HermesTraceBuffer = {
  /** Record one inbound raw frame, classifying it for the normalized column. */
  recordInbound(frame: InboundTraceInput): void;
  /** Record one outbound method call (params sanitized). */
  recordOutbound(call: OutboundTraceInput): void;
  /** Record one error/rejection. */
  recordError(error: ErrorTraceInput): void;
  /** Chronological entries for one session, oldest-first. */
  entriesFor(sessionId: string | undefined): HermesTraceEntry[];
  /** Session ids that currently have entries (real ids only, oldest-first). */
  sessionIds(): string[];
  /** A secrets-free export bundle for one session. */
  exportSanitizedTrace(sessionId: string | undefined): SanitizedTraceBundle;
  /** Subscribe to changes (for `useSyncExternalStore`). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Monotonic version, bumped on every mutation (the snapshot getter). */
  getVersion(): number;
};

/**
 * Creates an isolated buffer instance. The app holds one (see
 * {@link hermesTraceBuffer}); tests create their own so state never leaks.
 */
export function createHermesTraceBuffer(): HermesTraceBuffer {
  // sessionKey -> entries (chronological; oldest-first).
  const bySession = new Map<string, HermesTraceEntry[]>();
  const listeners = new Set<() => void>();
  let version = 0;
  let nextId = 0;

  function emit(): void {
    version += 1;
    for (const listener of listeners) listener();
  }

  function push(sessionId: string | undefined, entry: HermesTraceEntry): void {
    const key = sessionId ?? NO_SESSION_KEY;
    const entries = bySession.get(key) ?? [];
    entries.push(entry);
    // Bound the buffer: drop oldest beyond the cap.
    while (entries.length > TRACE_ENTRIES_PER_SESSION_CAP) {
      entries.shift();
    }
    bySession.set(key, entries);
    emit();
  }

  function recordInbound(frame: InboundTraceInput): void {
    const classified: JuneHermesEvent = classifyHermesEvent(frame);
    const sessionId =
      nonEmpty(frame?.session_id) ?? nonEmpty(eventSession(classified));
    const { payloadKeys, payloadPreview } = describePayload(frame?.payload);
    push(sessionId, {
      id: nextId++,
      direction: "inbound",
      observedAt: new Date().toISOString(),
      sessionId,
      rawType: nonEmpty(
        typeof frame?.type === "string" ? frame.type : undefined,
      ),
      normalizedKind: classified.kind,
      payloadKeys,
      payloadPreview,
    });
  }

  function recordOutbound(call: OutboundTraceInput): void {
    const sessionId = nonEmpty(call.sessionId);
    const { payloadKeys, payloadPreview } = describePayload(call.params);
    push(sessionId, {
      id: nextId++,
      direction: "outbound",
      observedAt: new Date().toISOString(),
      sessionId,
      method: call.method,
      payloadKeys,
      payloadPreview,
    });
  }

  function recordError(error: ErrorTraceInput): void {
    const sessionId = nonEmpty(error.sessionId);
    push(sessionId, {
      id: nextId++,
      direction: "error",
      observedAt: new Date().toISOString(),
      sessionId,
      method: nonEmpty(error.method),
      message: error.message,
      payloadKeys: [],
    });
  }

  function entriesFor(sessionId: string | undefined): HermesTraceEntry[] {
    const key = sessionId ?? NO_SESSION_KEY;
    return (bySession.get(key) ?? []).map(cloneEntry);
  }

  function sessionIds(): string[] {
    return [...bySession.keys()].filter((key) => key !== NO_SESSION_KEY);
  }

  function exportSanitizedTrace(
    sessionId: string | undefined,
  ): SanitizedTraceBundle {
    return {
      sessionId: nonEmpty(sessionId),
      exportedAt: new Date().toISOString(),
      // entriesFor already returns sanitized clones (previews derive from
      // sanitizePayload). Re-cloning keeps the export decoupled from live state.
      entries: entriesFor(sessionId),
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getVersion(): number {
    return version;
  }

  return {
    recordInbound,
    recordOutbound,
    recordError,
    entriesFor,
    sessionIds,
    exportSanitizedTrace,
    subscribe,
    getVersion,
  };
}

/**
 * The app-wide buffer. AgentWorkspace feeds it from the live gateway
 * subscription (inbound + errors) and the trace panel reads it. A singleton
 * (not React state) so the bounded buffer survives re-renders and any non-React
 * reader (the sanitized export) shares one source.
 */
export const hermesTraceBuffer = createHermesTraceBuffer();

/** The session id a classified event carries, if any (kinds differ in shape). */
function eventSession(event: JuneHermesEvent): string | undefined {
  return "sessionId" in event ? event.sessionId : undefined;
}

/**
 * Turns a (possibly raw) payload into the export-safe shape: top-level keys plus
 * a capped JSON preview. Always runs {@link sanitizePayload} first, so a raw
 * frame is never `JSON.stringify`-ed and secret values are masked at any depth.
 */
function describePayload(value: unknown): {
  payloadKeys: string[];
  payloadPreview?: string;
} {
  if (value === null || value === undefined) {
    return { payloadKeys: [] };
  }
  const safe = sanitizePayload(value);
  const payloadKeys =
    typeof safe === "object" && safe !== null && !Array.isArray(safe)
      ? Object.keys(safe as Record<string, unknown>)
      : [];
  let payloadPreview: string | undefined;
  try {
    const json = JSON.stringify(safe, null, 2);
    if (typeof json === "string") {
      payloadPreview =
        json.length > PREVIEW_MAX_LENGTH
          ? `${json.slice(0, PREVIEW_MAX_LENGTH)}…`
          : json;
    }
  } catch {
    // A value that can't be stringified (shouldn't happen post-sanitize) just
    // yields no preview rather than throwing.
    payloadPreview = undefined;
  }
  return { payloadKeys, payloadPreview };
}

function cloneEntry(entry: HermesTraceEntry): HermesTraceEntry {
  return { ...entry, payloadKeys: [...entry.payloadKeys] };
}
