/**
 * The typed event/command contract every Hermes-aware feature in June builds
 * on. Raw gateway frames (`raw-types.ts`) are classified into the
 * {@link JuneHermesEvent} union by `event-classifier.ts`; UI never touches the
 * raw wire. This module owns the canonical types — extend the unions here, not
 * in feature code, so the whole pack stays in sync.
 */

import { sessionUnrestricted } from "../agent-session-modes";

/**
 * Whether a session runs under the Seatbelt write-jail (`sandboxed`, the safe
 * default) or with full write access (`unrestricted`). June persists this as a
 * boolean today (see `agent-session-modes.ts`); this is the canonical named
 * type the pack shares. Derive it from a session id with {@link hermesModeFor}.
 */
export type HermesMode = "sandboxed" | "unrestricted";

/** Resolves a session's mode from the persisted opt-in. Absence (or an unknown
 * session) is `sandboxed` — the safe direction. */
export function hermesModeFor(sessionId: string | undefined): HermesMode {
  return sessionUnrestricted(sessionId) ? "unrestricted" : "sandboxed";
}

/** Maps the boolean the runtime stores onto the named mode. */
export function hermesModeFromUnrestricted(unrestricted: boolean): HermesMode {
  return unrestricted ? "unrestricted" : "sandboxed";
}

/**
 * Parse a raw `payload.mode` value into a {@link HermesMode}, or `undefined`
 * when it's neither known string. The ONE place a wire mode is validated — the
 * classifier and the chat runtime both call this, so a safety-relevant parse
 * never drifts between two copies. Unknown input is `undefined` (the caller
 * decides the safe default), never a coerced mode.
 */
export function parseHermesMode(value: unknown): HermesMode | undefined {
  return value === "sandboxed" || value === "unrestricted" ? value : undefined;
}

/**
 * An action the agent is blocked on until the user responds. Surfaced through
 * `pending_action` events and resolved with the matching method in
 * `methods.ts` (clarify/approval responses flow through the existing chat
 * runtime today; sudo/secret are wired by later features).
 */
export type PendingHermesAction =
  | { kind: "clarify"; requestId: string; question: string; choices?: string[] }
  | {
      kind: "approval";
      requestId: string;
      toolName?: string;
      description?: string;
      payload?: unknown;
    }
  | {
      kind: "sudo";
      requestId: string;
      command?: string;
      reason?: string;
      mode?: HermesMode;
    }
  | {
      kind: "secret";
      requestId: string;
      keyName?: string;
      reason?: string;
      /** Discriminator and a guarantee: the secret value is never carried on
       * this event, only the request for one. */
      redacted: true;
    };

/** The lifecycle phase a background subagent is reporting. */
export type BackgroundHermesPhase =
  | "start"
  | "progress"
  | "tool"
  | "thinking"
  | "complete"
  | "error"
  | "blocked";

/**
 * A delegated subagent's reported activity. Background features (the activity
 * drawer, subagent watch UI, interrupt control) read this instead of
 * re-parsing `subagent.*` payloads. Defensive: only `subagentId` and `phase`
 * are guaranteed.
 */
export type BackgroundHermesActivity = {
  subagentId: string;
  /** Hermes also calls the subagent's stable id a "handle" in some payloads;
   * preserved verbatim when present so callers can correlate either name. */
  handle?: string;
  parentSessionId?: string;
  phase: BackgroundHermesPhase;
  /** Human-readable goal/label for the subagent, when the event carries one. */
  goal?: string;
  /** The tool the subagent is using right now (for `tool`/`progress`). */
  currentTool?: string;
  /** A short preview of the subagent's latest output or completion summary. */
  resultPreview?: string;
  /** ISO timestamp this activity was observed (the event's `receivedAt` when
   * available, else classification time). */
  lastEventAt: string;
};

/**
 * The normalized event union. `classifyHermesEvent` returns exactly one of
 * these for every raw frame — including `unsupported` for anything unknown, so
 * a consumer can exhaustively `switch` on `kind` and never silently drop an
 * event.
 */
export type JuneHermesEvent =
  | {
      kind: "transcript";
      sessionId: string;
      messageId?: string;
      delta?: string;
      complete?: boolean;
      role?: "assistant" | "user" | "system";
    }
  | { kind: "reasoning"; sessionId: string; delta: string }
  | {
      kind: "tool";
      sessionId: string;
      toolCallId?: string;
      phase: "start" | "progress" | "complete";
      name?: string;
      payload?: unknown;
    }
  | { kind: "pending_action"; sessionId: string; action: PendingHermesAction }
  | {
      kind: "background_activity";
      sessionId: string;
      activity: BackgroundHermesActivity;
    }
  | { kind: "lifecycle"; sessionId?: string; status: string; payload?: unknown }
  | {
      kind: "error";
      sessionId?: string;
      message: string;
      code?: number;
      recoverable?: boolean;
    }
  | {
      kind: "unsupported";
      sessionId?: string;
      rawType?: string;
      sanitizedPayload?: unknown;
    };

/** The discriminant strings of {@link JuneHermesEvent}, handy for tests and
 * exhaustiveness assertions. */
export type JuneHermesEventKind = JuneHermesEvent["kind"];
