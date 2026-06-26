/**
 * The honest three-state decision behind switching the agent's text model.
 *
 * Picking a model in June always writes the app-wide default (so the next
 * session uses it). What it does to the session you are looking at depends on
 * whether one is running and whether Hermes accepted the `/model` dispatch:
 *
 * - `active-session-switched` — a session is live AND Hermes accepted the
 *   `/model` slash command (the gateway result is the only signal June trusts;
 *   raw `model.switch`/`model.changed` events classify as `unsupported`).
 * - `default-changed` — no session is running, so only the default moved; the
 *   copy says it applies to new sessions.
 * - `switch-failed` — a session is live but the dispatch failed or was
 *   rejected. June never claims the running session switched; the default is
 *   still saved, so the new model takes effect on the next session.
 *
 * The model-switch command itself lives in the typed seam
 * (`switchActiveSessionModel` in `hermes-control-plane/methods.ts`); this module
 * owns only the user-facing decision so it stays pure and unit-testable apart
 * from the 9k-line workspace.
 */

/** Which of the three honest states a model switch resolved to. */
export type ModelSwitchState =
  | "active-session-switched"
  | "default-changed"
  | "switch-failed";

export type ModelSwitchOutcome = {
  state: ModelSwitchState;
  /** Sentence-case notice for the composer status slot. No dashes (project
   * copy rule); ranges/joins are rewritten. */
  notice: string;
};

/** Shown when the live session accepted the switch. Names the model so the
 * user can trust the running turn actually moved. */
export function modelSwitchSuccessNotice(modelName: string): string {
  return `Switched this session to ${modelName}.`;
}

/** No session was running, so only the default changed. */
export const MODEL_SWITCH_DEFAULT_ONLY_NOTICE =
  "Default model updated. It applies to new sessions.";

/** A session was running but the switch did not take. Honest: the running
 * session is unchanged. The choice is saved as this chat's per-chat override
 * (never the global default), so it applies the next time this chat runs. */
export const MODEL_SWITCH_FAILED_NOTICE =
  "Could not switch the running session. This chat will use the new model next time.";

export type ResolveModelSwitchInput = {
  /** Whether a Hermes session is currently open and live. */
  hasActiveSession: boolean;
  /** Whether the `/model` dispatch to that session was accepted. Only
   * meaningful when {@link hasActiveSession} is true. */
  dispatchSucceeded: boolean;
  /** Human-readable name of the chosen model, for the success copy. */
  modelName: string;
};

/**
 * Maps the facts of a model change onto exactly one honest outcome. Pure: it
 * makes no claim the caller has not proven (an accepted gateway dispatch), so
 * the UI can never tell the user a running session switched when it did not.
 */
export function resolveModelSwitchOutcome(
  input: ResolveModelSwitchInput,
): ModelSwitchOutcome {
  if (!input.hasActiveSession) {
    return {
      state: "default-changed",
      notice: MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
    };
  }
  if (input.dispatchSucceeded) {
    return {
      state: "active-session-switched",
      notice: modelSwitchSuccessNotice(input.modelName),
    };
  }
  return { state: "switch-failed", notice: MODEL_SWITCH_FAILED_NOTICE };
}
