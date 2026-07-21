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
 * `methods.ts`; matching `*.response` frames surface separately as
 * `pending_action_resolution` events.
 */
export type PendingHermesAction =
  | { kind: "clarify"; requestId: string; question: string; choices?: string[] }
  | {
      kind: "approval";
      requestId: string;
      /** Present only when June synthesized the id from a sanitized legacy
       * payload. Runtime-provided ids remain globally replay-sticky. */
      requestIdProvenance?: "payload-fingerprint";
      /** June-owned identity for one actionable approval instance. The raw
       * request id is still used on the Hermes response wire. */
      instanceId?: string;
      toolName?: string;
      command?: string;
      description?: string;
      allowPermanent: boolean;
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

/** A user response that resolves a previously pending Hermes action. These
 * events are distinct from `pending_action`: the user already answered, so the
 * agent is expected to resume rather than remain blocked. */
export type PendingHermesActionResolution =
  | {
      kind: "clarify";
      requestId: string;
      question: string;
      choices: string[];
      answer: string;
    }
  | {
      kind: "approval";
      requestId: string;
      instanceId?: string;
      command: string;
      description: string;
      allowPermanent: boolean;
      choice?: "once" | "session" | "always" | "deny";
    }
  | {
      kind: "sudo";
      requestId: string;
      mode?: HermesMode;
      granted?: boolean;
    }
  | {
      kind: "secret";
      requestId: string;
      keyName?: string;
      reason?: string;
      /** Discriminator and a guarantee: a resolved secret event still carries
       * only metadata, never the value the user entered. */
      redacted: true;
    };

/** A pending approval that Hermes retired without a user decision. Expiration
 * is deliberately distinct from denial: neither outcome approves anything,
 * but only denial is an explicit user response. */
export type PendingHermesActionExpiration = {
  kind: "approval";
  requestId: string;
  instanceId?: string;
  reason:
    | "timeout"
    | "disconnect"
    | "overflow"
    | "stale"
    | "transport_handoff"
    | "unconfirmed"
    | "unknown";
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
  /** Zero-based task position when Hermes reports a fan-out batch. */
  taskIndex?: number;
  /** Total task count when Hermes reports a fan-out batch. */
  taskCount?: number;
  /** ISO timestamp this activity was observed (the event's `receivedAt` when
   * available, else classification time). */
  lastEventAt: string;
};

/** Delivery metadata used to deduplicate one gateway dispatch without treating
 * equal text as a duplicate. Source ids and text offsets survive reconnects;
 * connection ids and sequences are local to one gateway client connection. */
export type HermesEventDelivery = {
  connectionId?: number;
  sequence?: number;
  eventId?: string;
  /** UTF-16 code-unit offset within the transcript message. */
  textOffset?: number;
};

/** Common fields all normalized June events carry. */
type JuneHermesEventBase = {
  /** ISO timestamp when June observed or minted the event. */
  receivedAt: string;
  /** Stable source metadata when available, else local dispatch identity. */
  delivery?: HermesEventDelivery;
};

/**
 * The normalized event union. `classifyHermesEvent` returns exactly one of
 * these for every raw frame — including `unsupported` for anything unknown, so
 * a consumer can exhaustively `switch` on `kind` and never silently drop an
 * event.
 */
export type JuneHermesEvent =
  | (JuneHermesEventBase & {
      kind: "transcript";
      sessionId: string;
      messageId?: string;
      delta?: string;
      complete?: boolean;
      /** Hermes 0.19 seals mid-turn assistant commentary as its own bubble. */
      interim?: boolean;
      /** The final response extends an already-rendered interim preview. */
      responsePreviewed?: boolean;
      failed: boolean;
      role?: "assistant" | "user" | "system";
    })
  | (JuneHermesEventBase & {
      kind: "reasoning";
      sessionId: string;
      delta: string;
      /** True when `delta` carries the FULL reasoning text (a `*.available`
       * frame), not an incremental chunk. Consumers replace instead of append,
       * so a full replay after streamed deltas cannot duplicate the thought. */
      full?: boolean;
    })
  | (JuneHermesEventBase & {
      kind: "tool";
      sessionId: string;
      toolCallId?: string;
      phase: "start" | "progress" | "complete" | "failed";
      key: string;
      name?: string;
      text: string;
      isClarify: boolean;
      /** Pruned MCP/tool result media content. Kept so first-party image blocks
       * and validated MEDIA refs can render inline in the live turn; general
       * tool text still uses the sanitized/display fields above. */
      content?: unknown;
      /** Sanitized opaque payload for display/details. Keep consumers from
       * depending on raw wire structure. */
      sanitizedPayload?: unknown;
    })
  | (JuneHermesEventBase & {
      kind: "pending_action";
      sessionId: string;
      action: PendingHermesAction;
    })
  | (JuneHermesEventBase & {
      kind: "pending_action_resolution";
      sessionId: string;
      action: PendingHermesActionResolution;
    })
  | (JuneHermesEventBase & {
      kind: "pending_action_expiration";
      sessionId: string;
      action: PendingHermesActionExpiration;
    })
  | (JuneHermesEventBase & {
      kind: "background_activity";
      sessionId: string;
      activity: BackgroundHermesActivity;
    })
  | (JuneHermesEventBase & {
      kind: "steering";
      sessionId: string;
      text: string;
    })
  | (JuneHermesEventBase & {
      kind: "lifecycle";
      sessionId?: string;
      flavor: "terminal" | "running" | "info";
      status: string;
      text: string;
      payload?: unknown;
    })
  | (JuneHermesEventBase & {
      kind: "error";
      sessionId?: string;
      message: string;
      code?: number;
      recoverable?: boolean;
    })
  | (JuneHermesEventBase & {
      kind: "unsupported";
      sessionId?: string;
      rawType?: string;
      sanitizedPayload?: unknown;
    });

/** The discriminant strings of {@link JuneHermesEvent}, handy for tests and
 * exhaustiveness assertions. */
export type JuneHermesEventKind = JuneHermesEvent["kind"];

/** True for classified events that end the current Agent run. */
export function isTerminalHermesEvent(event: JuneHermesEvent): boolean {
  switch (event.kind) {
    case "error":
      return true;
    case "transcript":
      // A completed assistant message is only a transcript boundary. Hermes
      // may still emit tools, continuation text, or a later lifecycle frame
      // for the same run.
      return false;
    case "lifecycle":
      return event.flavor === "terminal";
    default:
      return false;
  }
}

/**
 * Build a first-party steering event for a user instruction sent into an
 * already-running session. This is local June state, NEVER produced by
 * `classifyHermesEvent`, because steering is not a Hermes wire frame.
 */
export function createSteeringEvent(
  sessionId: string,
  text: string,
  receivedAt: string,
): JuneHermesEvent {
  return {
    kind: "steering",
    sessionId,
    text,
    receivedAt,
  };
}
