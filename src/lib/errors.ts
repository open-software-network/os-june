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

/** Whether an error message means the request outgrew the model's context (or
 * the agent request-size limit) — a hard size failure the user must act on
 * (trim the input, attach a smaller file, start a fresh session), NOT something
 * to retry as-is. Like {@link isInsufficientCreditsMessage}, string matching is
 * a known weakness: the same condition reaches us as plain text from several
 * layers — the June API's `prompt_too_long`/`request_too_large`, the provider
 * proxy's rewritten "maximum context length" wording, and Hermes' terminal
 * "Cannot compress further." when it cannot shrink a single oversized turn
 * (JUN-169). */
export function isContextOverflowMessage(message?: string) {
  if (!message) return false;
  return /cannot compress further|context length exceeded|context_length_exceeded|maximum context length|prompt_too_long|request_too_large/i.test(
    message,
  );
}
