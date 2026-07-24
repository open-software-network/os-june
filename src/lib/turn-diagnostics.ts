/**
 * Per-turn development diagnostics for agent latency (JUN-436).
 *
 * Captures timing boundaries across one agent run (prompt submit through
 * terminal event) and token usage deltas, then formats a concise diagnostic
 * line that the chat UI renders when the experimental `turn_diagnostics` flag
 * is on.
 *
 * The store is framework-agnostic (no React) so the session event listener can
 * write to it outside React's render cycle. The UI adapts it with a small
 * `useSyncExternalStore` wrapper.
 *
 * Safety: diagnostics carry only timing, token counts, and model/provider
 * names. No prompt contents, credentials, or raw payloads are retained.
 */

import type { SessionUsage } from "./hermes-session-usage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mutable timing state captured during one agent run. Uses `performance.now()`
 * for monotonic elapsed measurement. */
export type TurnTimingState = {
  /** `performance.now()` at listener attach (just before `prompt.submit`). */
  submitAt: number;
  /** First non-empty assistant transcript delta (time to first token). */
  firstTokenAt?: number;
  /** Last successful `message.complete` (end of the last assistant segment). */
  lastMessageCompleteAt?: number;
  /** Terminal lifecycle event (end of the agent run). */
  terminalAt?: number;
};

/** Token usage snapshot for delta computation. */
export type TurnUsageSnapshot = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  provider?: string;
};

/** Computed diagnostics ready for display. */
export type TurnDiagnostics = {
  /** Monotonic milliseconds from submit to terminal. */
  totalDurationMs: number;
  /** Submit to first token (end-to-end time to first token). */
  ttftMs: number;
  /** First token to last message.complete (active streaming + tool calls +
   * inter-segment orchestration). Not pure provider time. */
  responseSpanMs: number;
  /** Last message.complete to terminal (tail: post-response runtime work). */
  tailMs: number;
  /** Output tokens (delta of completion tokens, or undefined if baseline
   * was unavailable). */
  outputTokens?: number;
  /** Input tokens (delta of prompt tokens, or undefined if baseline
   * was unavailable). */
  inputTokens?: number;
  /** Total tokens (delta, or undefined if baseline was unavailable). */
  totalTokens?: number;
  /** Cache read tokens (delta, or undefined if baseline was unavailable). */
  cacheReadTokens?: number;
  /** Cache write tokens (delta, or undefined if baseline was unavailable). */
  cacheWriteTokens?: number;
  /** Output throughput: output tokens / response span seconds. */
  tps?: number;
  /** Model name from usage snapshot. */
  model?: string;
  /** Provider name from usage snapshot. */
  provider?: string;
  /** ISO timestamp when diagnostics were finalized. */
  finalizedAt: string;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
const diagnosticsBySession = new Map<string, TurnDiagnostics>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Publish diagnostics for a session. Called from the session event listener
 * at the terminal event. Overwrites any previous diagnostics for this session. */
export function publishTurnDiagnostics(sessionId: string, diagnostics: TurnDiagnostics): void {
  diagnosticsBySession.set(sessionId, diagnostics);
  emit();
}

/** Clear diagnostics for a session. Called when a new run begins so stale
 * diagnostics from a prior run do not reappear. */
export function clearTurnDiagnostics(sessionId: string): void {
  if (diagnosticsBySession.delete(sessionId)) emit();
}

/** Read the latest diagnostics for a session, or undefined. */
export function getTurnDiagnostics(sessionId: string | undefined): TurnDiagnostics | undefined {
  if (!sessionId) return undefined;
  return diagnosticsBySession.get(sessionId);
}

/** Subscribe to store changes for `useSyncExternalStore`. Returns unsubscribe. */
export function subscribeTurnDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic version for `useSyncExternalStore` snapshot. */
export function getTurnDiagnosticsVersion(): number {
  return version;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/** Extract a usage snapshot from a parsed `SessionUsage`. */
export function snapshotFromUsage(usage: SessionUsage | undefined): TurnUsageSnapshot {
  if (!usage) return {};
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    model: usage.model,
    provider: usage.provider,
  };
}

/** Extract cache token fields from a raw `session.usage` result. The normalized
 * `SessionUsage` parser does not currently surface cache metrics, so we read
 * them defensively from the raw payload the same way the parser does. */
export function cacheSnapshotFromRaw(raw: unknown): {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  if (!raw || typeof raw !== "object") return {};
  const root = raw as Record<string, unknown>;
  const usage = root.usage as Record<string, unknown> | undefined;
  const containers = [usage, root].filter(
    (c): c is Record<string, unknown> => c !== null && c !== undefined,
  );

  function pickNum(keys: string[]): number | undefined {
    for (const container of containers) {
      for (const key of keys) {
        const val = container[key];
        if (typeof val === "number" && Number.isFinite(val)) return val;
      }
    }
    return undefined;
  }

  return {
    cacheReadTokens: pickNum([
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cache_read_tokens",
      "cacheReadTokens",
      "cached_tokens",
      "cachedTokens",
    ]),
    cacheWriteTokens: pickNum([
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
      "cache_write_tokens",
      "cacheWriteTokens",
      "cache_creation_tokens",
      "cacheCreationTokens",
    ]),
  };
}

/** Compute per-turn diagnostics from timing state and usage deltas.
 *
 * Token deltas require both a before and after snapshot. If the before
 * snapshot is unavailable (the baseline RPC raced or failed), token fields
 * are left undefined rather than showing cumulative absolute values. */
export function computeTurnDiagnostics(
  timing: TurnTimingState,
  usageBefore: TurnUsageSnapshot,
  usageAfter: TurnUsageSnapshot,
): TurnDiagnostics | undefined {
  if (timing.terminalAt === undefined) return undefined;

  const totalDurationMs = timing.terminalAt - timing.submitAt;
  if (totalDurationMs <= 0) return undefined;

  const firstTokenAt = timing.firstTokenAt ?? timing.terminalAt;
  const lastCompleteAt = timing.lastMessageCompleteAt ?? timing.terminalAt;

  const ttftMs = Math.max(0, firstTokenAt - timing.submitAt);
  const responseSpanMs = Math.max(0, lastCompleteAt - firstTokenAt);
  const tailMs = Math.max(0, timing.terminalAt - lastCompleteAt);

  const hasBaseline = usageBefore.promptTokens !== undefined;
  const outputTokens = delta(
    usageBefore.completionTokens,
    usageAfter.completionTokens,
    hasBaseline,
  );
  const inputTokens = delta(usageBefore.promptTokens, usageAfter.promptTokens, hasBaseline);
  const totalTokens = delta(usageBefore.totalTokens, usageAfter.totalTokens, hasBaseline);
  const cacheReadTokens = delta(
    usageBefore.cacheReadTokens,
    usageAfter.cacheReadTokens,
    hasBaseline,
  );
  const cacheWriteTokens = delta(
    usageBefore.cacheWriteTokens,
    usageAfter.cacheWriteTokens,
    hasBaseline,
  );

  const responseSpanSeconds = responseSpanMs / 1000;
  const tps =
    outputTokens !== undefined && responseSpanSeconds > 0
      ? outputTokens / responseSpanSeconds
      : undefined;

  return {
    totalDurationMs,
    ttftMs,
    responseSpanMs,
    tailMs,
    outputTokens,
    inputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tps,
    model: usageAfter.model,
    provider: usageAfter.provider,
    finalizedAt: new Date().toISOString(),
  };
}

/** Compute a per-turn token delta. When the baseline snapshot is unavailable,
 * returns undefined instead of the cumulative absolute value. */
function delta(
  before: number | undefined,
  after: number | undefined,
  hasBaseline: boolean,
): number | undefined {
  if (after === undefined) return undefined;
  if (!hasBaseline || before === undefined) return undefined;
  return Math.max(0, after - before);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  if (ms < 100) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  return n.toLocaleString();
}

/** Format the diagnostics as a concise single-line summary. */
export function formatTurnDiagnostics(d: TurnDiagnostics): string {
  const parts: string[] = [
    `turn ${fmtMs(d.totalDurationMs)}`,
    `TTFT ${fmtMs(d.ttftMs)}`,
    `stream ${fmtMs(d.responseSpanMs)}`,
    `tail ${fmtMs(d.tailMs)}`,
  ];

  if (d.tps !== undefined) {
    parts.push(`TPS ${d.tps.toFixed(1)} tok/s`);
  }

  const tokenParts: string[] = [];
  if (d.outputTokens !== undefined) tokenParts.push(`out ${fmtTokens(d.outputTokens)}`);
  if (d.inputTokens !== undefined) tokenParts.push(`in ${fmtTokens(d.inputTokens)}`);
  if (d.cacheReadTokens !== undefined || d.cacheWriteTokens !== undefined) {
    tokenParts.push(`cache r/w ${fmtTokens(d.cacheReadTokens)}/${fmtTokens(d.cacheWriteTokens)}`);
  }
  if (d.totalTokens !== undefined) tokenParts.push(`total ${fmtTokens(d.totalTokens)}`);
  if (tokenParts.length > 0) {
    parts.push(tokenParts.join(", "));
  }

  if (d.model) {
    parts.push(d.model);
  }

  return parts.join(" \u00b7 ");
}
