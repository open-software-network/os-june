/**
 * The single error type every Hermes admin call rejects with. It is the admin
 * analogue of `HermesGatewayError` (which carries a JSON-RPC code for the live
 * socket): here the transport is REST, so the error carries HTTP status, a
 * Hermes error `code` when the body provides one, a `safeMessage` that is always
 * fit to show a user, a `retryable` hint, and a SHORT redacted body preview for
 * developers.
 *
 * Two hard rules this type enforces:
 * - `safeMessage` is generic and never echoes a server body verbatim (a body
 *   can contain the secret the caller just submitted). UI renders this.
 * - `rawBodyPreview` is for a debug dump only and is ALWAYS run through
 *   {@link redactBodyPreview} before being stored. Even so, treat it as
 *   developer-only.
 */

import { redactBodyPreview } from "./redact";

/** How the failure happened, so callers can branch without string-matching the
 * message. `http` is a non-2xx response; `network` is a fetch/transport
 * failure; `parse` is a 2xx body that failed schema validation; `timeout` is a
 * client-side abort; `offline` is "no live Hermes runtime to target". */
export type HermesAdminErrorKind =
  | "http"
  | "network"
  | "parse"
  | "timeout"
  | "offline";

/** The longest raw body we keep for debugging. Long enough to be useful, short
 * enough that a redaction miss has a bounded blast radius. */
const RAW_BODY_PREVIEW_MAX = 500;

export type HermesAdminErrorInit = {
  endpoint: string;
  kind: HermesAdminErrorKind;
  status?: number;
  /** Hermes' own error code from the response body (e.g. `"not_found"`), when
   * present. Distinct from the HTTP status. */
  code?: string;
  /** Generic, user-safe summary. Defaulted from kind/status when omitted. */
  safeMessage?: string;
  retryable?: boolean;
  /** Raw response body; redacted and truncated on the way in. */
  rawBody?: string;
};

/**
 * Normalized admin-request failure. Construct via {@link HermesAdminError.from}
 * or the helpers below, never by hand, so the safe-message defaulting and body
 * redaction always run.
 */
export class HermesAdminError extends Error {
  /** Request path that failed, e.g. `"PUT /api/skills/toggle"`. Already
   * redacted (the path carries no secrets, but a query token would be). */
  readonly endpoint: string;
  readonly kind: HermesAdminErrorKind;
  readonly status?: number;
  readonly code?: string;
  /** Always safe to render to a user; never the raw server body. */
  readonly safeMessage: string;
  /** Whether retrying the same request might succeed (5xx, network, timeout). */
  readonly retryable: boolean;
  /** Redacted, truncated body preview for developers. Not for UI. */
  readonly rawBodyPreview?: string;

  constructor(init: HermesAdminErrorInit) {
    const safeMessage =
      init.safeMessage ?? defaultSafeMessage(init.kind, init.status);
    // The Error message itself must be safe: it can land in a console or a
    // generic crash reporter, so it gets the SAFE text, never the raw body.
    super(safeMessage);
    this.name = "HermesAdminError";
    this.endpoint = init.endpoint;
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.safeMessage = safeMessage;
    this.retryable = init.retryable ?? defaultRetryable(init.kind, init.status);
    this.rawBodyPreview =
      init.rawBody === undefined
        ? undefined
        : redactBodyPreview(init.rawBody).slice(0, RAW_BODY_PREVIEW_MAX);
  }

  /** Coerces any thrown value into a HermesAdminError so callers always catch
   * the same type. An existing HermesAdminError passes through unchanged. */
  static from(endpoint: string, error: unknown): HermesAdminError {
    if (error instanceof HermesAdminError) return error;
    if (isAbortError(error)) {
      return new HermesAdminError({ endpoint, kind: "timeout" });
    }
    return new HermesAdminError({ endpoint, kind: "network" });
  }

  /** A structured, log-safe view. Every field here is already redacted; safe to
   * `JSON.stringify` into a debug trace. */
  toLogSafe(): Record<string, unknown> {
    return {
      name: this.name,
      endpoint: this.endpoint,
      kind: this.kind,
      status: this.status,
      code: this.code,
      safeMessage: this.safeMessage,
      retryable: this.retryable,
      rawBodyPreview: this.rawBodyPreview,
    };
  }
}

/** True for a fetch abort (our client-side timeout), so {@link
 * HermesAdminError.from} can label it `timeout` rather than `network`. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** A generic, user-safe message for a kind/status. Deliberately says nothing
 * about the response body. */
function defaultSafeMessage(
  kind: HermesAdminErrorKind,
  status?: number,
): string {
  switch (kind) {
    case "offline":
      return "Hermes is not running.";
    case "network":
      return "Could not reach Hermes.";
    case "timeout":
      return "The request to Hermes timed out.";
    case "parse":
      return "Hermes returned an unexpected response.";
    case "http":
      if (status === 401 || status === 403) {
        return "Hermes rejected the request (not authorized).";
      }
      if (status === 404) return "That Hermes resource was not found.";
      if (status === 409)
        return "That change conflicts with the current state.";
      if (status !== undefined && status >= 500) {
        return "Hermes ran into a problem with that request.";
      }
      return "Hermes could not complete that request.";
  }
}

/** Default retryability: transport-level failures and 5xx are retryable; a 4xx
 * is the caller's fault and a parse failure won't fix itself on retry. */
function defaultRetryable(
  kind: HermesAdminErrorKind,
  status?: number,
): boolean {
  if (kind === "network" || kind === "timeout") return true;
  if (kind === "http") return status !== undefined && status >= 500;
  return false;
}
