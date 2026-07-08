/**
 * User-facing notices for the composer model control.
 *
 * June lets the composer choose the text-model default before a Hermes session
 * exists. Once a session exists, the model is fixed for that thread; the
 * composer renders the current model as passive status instead of offering a
 * picker.
 */

/** No session was running, so only the default changed. */
export const MODEL_SWITCH_DEFAULT_ONLY_NOTICE =
  "Default model updated. It applies to new sessions.";

/** Existing sessions are model-locked; switch by starting a fresh session. */
export const MODEL_CHANGE_LOCKED_NOTICE = "Start a new session to change models.";
