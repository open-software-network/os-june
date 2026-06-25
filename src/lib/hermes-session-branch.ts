/**
 * Session branching (fork from message) — the typed result feature 07 needs to
 * open the forked session, parsed defensively from the raw `session.branch`
 * result.
 *
 * The gateway's `methods.branchSession(...)` resolves to `unknown`: Hermes may
 * report the fork under different keys between pins (`new_session_id`,
 * `session_id`, a nested `session.id`), and the recorded fixture
 * (`hermes-control-plane/fixtures/branch.json`) carries `from_message_id` +
 * `new_session_id` + `title`. So this module owns the ONE place that turns that
 * raw blob into a {@link BranchSessionResult}.
 *
 * CONTRACT: the returned session id is AUTHORITATIVE — June opens whatever the
 * gateway minted and never invents a local id. A result that only echoes the
 * source session id is treated as "no fork happened" (`undefined`) rather than
 * silently re-selecting the source.
 */

import { asRecord, nonEmptyString, pickString } from "./hermes-control-plane";

/** The forked session, normalized. `sessionId` is the gateway-minted id of the
 * new session; the source ids are carried through for the "Branched from …"
 * banner and for remembering the new session's mode. */
export type BranchSessionResult = {
  /** The gateway-minted id of the new (forked) session. Authoritative. */
  sessionId: string;
  /** The session this fork came from. */
  sourceSessionId: string;
  /** The message the fork started from, when the branch was message-level. */
  sourceMessageId?: string;
};

/**
 * Parse a raw `session.branch` result into a {@link BranchSessionResult}.
 * Defensive by design: unknown shape in, normalized shape out. Returns
 * `undefined` when no usable NEW session id is present — including when the
 * result only repeats the source id, which means nothing was forked.
 *
 * `fallback` carries what the caller already knows (the source session it asked
 * to branch, and the message it branched from); the result's own values win
 * when present, the fallback fills the gaps.
 */
export function parseBranchSessionResult(
  raw: unknown,
  fallback: { sourceSessionId: string; sourceMessageId?: string },
): BranchSessionResult | undefined {
  const root = asRecord(raw);
  const nested = asRecord(root?.session);
  const sessionId = pickString(
    [root, nested],
    ["new_session_id", "newSessionId", "session_id", "sessionId", "id"],
  );
  // No new id, or an id that merely echoes the source, is not a fork.
  if (!sessionId || sessionId === fallback.sourceSessionId) return undefined;

  const sourceSessionId =
    pickString(
      [root],
      ["source_session_id", "sourceSessionId", "from_session_id"],
    ) ?? fallback.sourceSessionId;
  const sourceMessageId =
    pickString(
      [root],
      ["from_message_id", "fromMessageId", "source_message_id"],
    ) ?? fallback.sourceMessageId;

  return { sessionId, sourceSessionId, sourceMessageId };
}

/**
 * Prefixes the transcript turn-builder mints for turns that are NOT backed by a
 * persisted Hermes message: in-flight assistant turns (`assistant:…`), a turn
 * that died on an error (`error:…`), and the optimistic user echo before its
 * send persists (`pending:…`). A branch from one of these would pass a
 * client-side id Hermes never assigned, faking message-level precision.
 */
const SYNTHETIC_TURN_ID_PREFIXES = ["assistant:", "error:", "pending:"];

/**
 * Whether a transcript turn id is a stable, persisted Hermes message id that
 * can be passed as `from_message_id`. Only persisted messages carry a real
 * gateway id; everything the turn builder mints client-side is rejected so the
 * UI can honestly gate (and explain) message-level branching instead of faking
 * it.
 */
export function isBranchableMessageId(id: string | undefined): boolean {
  const trimmed = nonEmptyString(id);
  if (!trimmed) return false;
  return !SYNTHETIC_TURN_ID_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix),
  );
}
