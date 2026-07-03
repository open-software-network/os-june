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
 * - builds the first-party control-plane event that renders the user's
 *   instruction as a "Steering: <text>" system item in the transcript.
 *
 * It is deliberately UI- and gateway-free so it stays trivially unit-testable
 * and so only this seam changes if the wire payload shape moves.
 */

import { isSessionBusyError } from "./hermes-gateway";
import { messageFromError } from "./errors";
import { createSteeringEvent, type JuneHermesEvent } from "./hermes-control-plane";

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

/**
 * Build the first-party local live event for a sent instruction. Pushed onto
 * the session's live-event list so {@link buildHermesSessionChatTurns} renders
 * it as a steering system turn at `receivedAt` order. Carries only the
 * normalized text — no gateway result, no secret material.
 */
export function steeringLiveEvent(params: {
  sessionId: string;
  text: string;
  receivedAt: string;
}): JuneHermesEvent {
  return createSteeringEvent(params.sessionId, params.text, params.receivedAt);
}
