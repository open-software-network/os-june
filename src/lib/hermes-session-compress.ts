/**
 * Normalized result of a `session.compress` call — the typed shape feature 08's
 * compaction flow reads, parsed defensively from the raw result.
 *
 * The gateway's `methods.compressSession(...)` resolves to `unknown`: Hermes can
 * add, rename, or drop fields between pins, and may report token counts under
 * snake_case or camelCase keys (or omit them entirely when it only inserts a
 * summary without metering the delta). So this module owns the ONE place that
 * turns that raw blob into {@link CompressSessionResult}. Every metric is
 * optional and stays `undefined` when absent or malformed; the parser tolerates
 * both key styles and never throws on junk. The UI shows token/context savings
 * only when both before and after are present, and otherwise still reports a
 * plain success.
 *
 * Mirrors `hermes-session-usage.ts` (feature 09): same defensive `asRecord` /
 * `finiteNumber` / `pickNumber` / `pickString` helpers (shared from
 * `hermes-control-plane/parse`), same "missing in, undefined out" contract.
 */

import {
  asRecord,
  finiteNumber,
  pickNumber,
  pickString,
} from "./hermes-control-plane";

/** Normalized, UI-ready result for one `session.compress` call. All metrics
 * optional: a field is present only when the gateway reported a usable value. */
export type CompressSessionResult = {
  sessionId: string;
  /** Total tokens in the working context BEFORE compaction, when reported. */
  beforeTokens?: number;
  /** Total tokens in the working context AFTER compaction, when reported. */
  afterTokens?: number;
  /** Id of the summary message the gateway inserted, when reported. */
  summaryMessageId?: string;
  /** The untouched gateway result, kept for the trace panel / debugging. */
  raw?: unknown;
};

/**
 * Parse a raw `session.compress` result into a {@link CompressSessionResult}.
 * Defensive by design: unknown shape in, normalized shape out, missing/malformed
 * fields left `undefined`. `sessionId` is always carried through from the caller
 * so the UI can label which session it describes even when the payload omits it.
 */
export function parseCompressSessionResult(
  sessionId: string,
  raw: unknown,
): CompressSessionResult {
  const root = asRecord(raw);
  // Token deltas may live at the root or under a `usage` / `tokens` /
  // `context` sub-object depending on the pin.
  const usage = asRecord(root?.usage) ?? asRecord(root?.tokens);
  const context = asRecord(root?.context);
  const tokenContainers = [root, usage, context];

  return {
    sessionId,
    beforeTokens: pickNumber(tokenContainers, [
      "before_tokens",
      "beforeTokens",
      "tokens_before",
      "tokensBefore",
      "before",
    ]),
    afterTokens: pickNumber(tokenContainers, [
      "after_tokens",
      "afterTokens",
      "tokens_after",
      "tokensAfter",
      "after",
    ]),
    summaryMessageId: pickString(
      [root],
      [
        "summary_message_id",
        "summaryMessageId",
        "summary_id",
        "summaryId",
        "message_id",
        "messageId",
      ],
    ),
    raw,
  };
}
