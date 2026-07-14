/**
 * User-facing notices for the composer model control.
 *
 * June lets the composer choose the text-model default before a Hermes session
 * exists. Once a session exists, a new choice is session-local and applies to
 * the next user message. An active agent run keeps the model it started with.
 */

/** No session was running, so only the default changed. */
export const MODEL_SWITCH_DEFAULT_ONLY_NOTICE =
  "Default model updated. It applies to new sessions.";

/** An existing session queued the choice for its next user message. */
export const MODEL_SWITCH_NEXT_MESSAGE_NOTICE =
  "Model changed. It will be used for your next message.";
