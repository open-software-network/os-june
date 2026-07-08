/** Human-readable message from a thrown value — Tauri command errors arrive
 * as objects with a `message` field, everything else falls back to String. */
export function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Stable error code from a thrown Tauri `AppError` (`{ code, message }`),
 * or undefined for anything without one. Lets callers branch on a specific
 * failure (e.g. "referrals_unavailable") instead of matching message text. */
export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Whether an error means buying credits is gated behind the Max plan. Robust
 * to every shape the gate can reach us in: the structured Rust AppError code
 * (`top_up_requires_max`, mapped in os_accounts.rs from the accounts
 * envelope), the raw numeric envelope code (3002) should a payload ever pass
 * through unmapped, and the canonical message ("Buying credits requires the
 * Max plan.") as a last resort. */
export function isTopUpRequiresMaxError(err: unknown): boolean {
  if (errorCode(err) === "top_up_requires_max") return true;
  if (numericErrorCode(err) === 3002) return true;
  return /requires the max plan/i.test(messageFromError(err));
}

/** Numeric error code from a raw accounts envelope (`error_code`) or any
 * error object carrying a numeric code field, or undefined when absent. */
function numericErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const shape = err as { code?: unknown; error_code?: unknown; errorCode?: unknown };
  for (const value of [shape.error_code, shape.errorCode, shape.code]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

export function isHermesSessionsStartupRequestError(err: unknown) {
  return /error sending request for url \(http:\/\/127\.0\.0\.1:\d+\/api\/sessions(?:\?|[)/])/i.test(
    messageFromError(err),
  );
}

/** Whether an error message means the user's balance ran out. String match is
 * intentional and a known weakness — billing failures reach us as plain text
 * from several layers (Tauri commands, the Hermes runtime's provider errors),
 * none of which carry a structured code today. The patterns cover the June
 * API's friendly message and the raw provider error
 * (`... 'error_code': 4301, 'message': 'insufficient_credits'`). */
export function isInsufficientCreditsMessage(message?: string) {
  if (!message) return false;
  return /out of credits|insufficient credits|insufficient_credits|balance is too low/i.test(
    message,
  );
}

/** Whether a Tauri error is a Hermes REST 5xx. The desktop bridge's session
 * commands surface a non-2xx response as `Hermes API returned <status>: <body>`
 * (see `hermes_bridge.rs`); a 5xx is a transient server-side fault worth a
 * retry, unlike a 4xx (the caller's request) or a bridge-down connection error.
 * String matching mirrors the other classifiers here — the wire string carries
 * no structured code today. The `\b` after the status keeps the match anchored
 * to the three-digit code regardless of the trailing `:` or reason phrase. */
export function isHermesServerError(message?: string) {
  if (!message) return false;
  return /Hermes API returned 5\d\d\b/.test(message);
}

export const HERMES_SERVER_ERROR_MESSAGE = "June ran into a problem with that request.";

/** Human-readable Hermes command error. Transient Hermes REST 5xx errors are
 * local runtime faults, so user-facing surfaces should not leak the raw bridge
 * wire string (`Hermes API returned 500: ...`). */
export function describeHermesError(err: unknown): string {
  const message = messageFromError(err);
  return isHermesServerError(message) ? HERMES_SERVER_ERROR_MESSAGE : message;
}

/** Whether an error message means the request outgrew the model's context (or
 * the agent request-size limit) — a hard size failure the user must act on
 * (trim the input, attach a smaller file, start a fresh session), NOT something
 * to retry as-is. Like {@link isInsufficientCreditsMessage}, string matching is
 * a known weakness: the same condition reaches us as plain text from several
 * layers — the June API's `prompt_too_long`/`request_too_large`, the provider
 * proxy's rewritten "maximum context length" wording, and Hermes' terminal
 * "Cannot compress further." when it cannot shrink a single oversized turn
 * (JUN-169).
 *
 * BROAD match, including natural-language phrasings ("maximum context length")
 * that also occur in ordinary assistant prose. Use this ONLY where the turn is
 * already known to have failed — a live `error` event, or a `message.complete`
 * carrying an error status. For a persisted/reloaded turn that carries no
 * failure flag, use {@link isContextOverflowErrorSentinel} instead. */
export function isContextOverflowMessage(message?: string) {
  if (!message) return false;
  return /cannot compress further|context length exceeded|context_length_exceeded|maximum context length|prompt_too_long|string_too_long|request_too_large/i.test(
    message,
  );
}

/** STRICT context-overflow match: only the error sentinels that never occur in
 * natural prose. For classifying a persisted turn that carries no failure flag
 * (mirrors the credits path's "Error:"-prefix gate). Without this, a saved
 * assistant answer that merely discusses "the maximum context length" would
 * reload as an overflow notice and drop the real answer (JUN-169). Every real
 * overflow error still contains one of these tokens: the proxy prefixes
 * `prompt_too_long`, and Hermes' terminal message says "Cannot compress
 * further." */
export function isContextOverflowErrorSentinel(message?: string) {
  if (!message) return false;
  const text = message.trimStart();
  // Match an error SHAPE, never a mid-sentence mention (JUN-169 review). Two
  // shapes reach a persisted turn:
  //   1. the runtime's "Error:" sentinel — how Hermes persists a provider
  //      failure, e.g. `Error: Error code: 400 - {… 'prompt_too_long …'}` (the
  //      same shape the credits path keys on). Treat it as a known error and
  //      match the token anywhere inside it.
  //   2. a bare rejection that LEADS with its own token/shape — the proxy
  //      rewrite (`prompt_too_long: …`) or Hermes' terminal "Context length
  //      exceeded (…). Cannot compress further."
  // Requiring the "Error:" colon (tighter than the credits path's bare `error`
  // word) keeps prose like "Error handling returns prompt_too_long" as text,
  // and a leading token/shape keeps "the API can return prompt_too_long" as text.
  if (/^error:/i.test(text)) return isContextOverflowMessage(text);
  return /^(cannot compress further|context_length_exceeded|context length exceeded|prompt_too_long|string_too_long|request_too_large)\b/i.test(
    text,
  );
}
