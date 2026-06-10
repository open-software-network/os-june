/** Human-readable message from a thrown value — Tauri command errors arrive
 * as objects with a `message` field, everything else falls back to String. */
export function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Whether an error message means the user's balance ran out. String match is
 * intentional and a known weakness — billing failures reach us as plain text
 * from several layers (Tauri commands, the Hermes runtime's provider errors),
 * none of which carry a structured code today. The patterns cover the Scribe
 * API's friendly message and the raw provider error
 * (`... 'error_code': 4301, 'message': 'insufficient_credits'`). */
export function isInsufficientCreditsMessage(message?: string) {
  if (!message) return false;
  return /out of credits|insufficient credits|insufficient_credits|balance is too low/i.test(
    message,
  );
}
