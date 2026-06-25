/**
 * Pure helpers for live session steering (feature 06).
 *
 * Steering adds a mid-run instruction to a session that is ALREADY working,
 * through the typed `session.steer` control-plane method (never `prompt.submit`
 * — that path bounces off the gateway's 4009 busy guard). The gateway result is
 * an opaque ack, so June owns how a steer turns into transcript + error copy.
 *
 * This module is the one place that:
 * - validates/normalizes the instruction text before it is sent;
 * - maps a rejected `steerSession(...)` into clear, recoverable UI copy
 *   (session busy, dropped connection, or a generic instruction failure)
 *   without leaking JSON-RPC codes or raw provider noise;
 * - builds the synthetic LOCAL live event that renders the user's instruction
 *   as a "Steering: <text>" system item in the transcript.
 *
 * It is deliberately UI- and gateway-free so it stays trivially unit-testable
 * and so only this seam changes if the wire payload shape moves.
 */

import { isSessionBusyError } from "./hermes-gateway";
import { messageFromError } from "./errors";
import type { LiveHermesEvent } from "./agent-chat-runtime";

/**
 * Synthetic event type for a steering instruction. It is NOT a Hermes frame —
 * it is minted locally and pushed onto the same per-session live-event channel
 * the gateway frames flow through, so the existing turn builder renders it,
 * orders it by timestamp, and survives re-renders for free. The `june.` prefix
 * keeps it clearly first-party and outside Hermes' namespace.
 */
export const STEER_EVENT_TYPE = "june.steer" as const;

/** Trim an instruction and reject blank input. Interior whitespace/newlines are
 * preserved; only a fully empty/whitespace string yields `undefined` so callers
 * never send (or render) an empty steer. */
export function normalizeSteerText(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Map a rejected steer into clear, recoverable copy. Branches on the structured
 * 4009 busy code first (the expected race: the turn ended between the input
 * appearing and the send), then on the bridge/connection shape, and otherwise
 * falls back to a plain instruction-failed line. Never surfaces the raw code or
 * provider error string, and never uses typographic dashes.
 */
export function steerErrorNotice(err: unknown): string {
  if (isSessionBusyError(err)) {
    return "June can't take an instruction right now. It already finished the previous step. Send your message normally instead.";
  }
  if (isConnectionError(err)) {
    return "Lost the connection to June before the instruction was sent. Reconnect and try again.";
  }
  return "Couldn't send that instruction. Please try again.";
}

/** Connection-shaped failures: the gateway/bridge never came up or the socket
 * dropped before the steer was acked. Matched on the messages those paths throw
 * (see `ensureHermesGateway` and the gateway client). */
function isConnectionError(err: unknown): boolean {
  return /gateway url|bridge|websocket|socket|connection|disconnect|not connected|closed/i.test(
    messageFromError(err),
  );
}

/** The instruction text carried by a steering live event's payload, or "". */
export function steeringPartText(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Build the synthetic local live event for a sent instruction. Pushed onto the
 * session's live-event list so {@link buildHermesSessionChatTurns} renders it as
 * a steering system turn at `receivedAt` order. Carries only the normalized text
 * — no gateway result, no secret material.
 */
export function steeringLiveEvent(params: {
  sessionId: string;
  text: string;
  receivedAt: string;
}): LiveHermesEvent {
  return {
    type: STEER_EVENT_TYPE,
    session_id: params.sessionId,
    payload: { text: params.text },
    receivedAt: params.receivedAt,
  };
}
