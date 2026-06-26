/**
 * The request core every Hermes admin call funnels through. It is the admin
 * analogue of the Rust bridge's `hermes_connection_json`: same auth header
 * (`X-Hermes-Session-Token`), same `Content-Type: application/json`, same
 * "non-2xx is an error, empty body is null" handling. June's CSP already allows
 * `connect-src http://127.0.0.1:*`, so the renderer talks to the local
 * dashboard directly here rather than round-tripping every admin call through a
 * Tauri command. Nothing is shelled out and the URL is built from a typed
 * target, so command construction stays argument-safe.
 *
 * Responsibilities, all in this one place so no React component reimplements
 * them:
 * - attach the dashboard token consistently;
 * - encode the profile query parameter consistently;
 * - enforce a client-side timeout (AbortController);
 * - parse JSON with a caller-supplied defensive validator;
 * - normalize EVERY failure into a {@link HermesAdminError};
 * - redact before logging — the token, the URL query, request bodies, and
 *   response bodies never reach a log line in the clear.
 *
 * `fetch` is injectable so unit tests and the fake Hermes server (spec 24) drive
 * the client without a real runtime.
 */

import { HermesAdminError } from "./errors";
import { redactForLog, redactUrl } from "./redact";
import type { HermesAdminTarget } from "./target";
import { DEFAULT_HERMES_PROFILE } from "./target";

/** The subset of `fetch` this module needs, so a mock or the fake server can be
 * substituted without satisfying the entire DOM `fetch` signature. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** A diagnostics sink. Receives ALREADY-REDACTED structured records; it must
 * never see a raw secret. Defaults to a no-op (admin traffic is silent unless a
 * caller opts into logging). */
export type AdminLogger = (record: Record<string, unknown>) => void;

export type AdminTransportOptions = {
  fetch?: FetchLike;
  /** Per-request timeout in ms. Mirrors the Rust bridge's 30s default. */
  timeoutMs?: number;
  /** Optional redacted-only diagnostics sink. */
  logger?: AdminLogger;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export type AdminRequestInit = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path beginning with `/api/...`. Query params are added via `query`. */
  path: string;
  /** JSON body for POST/PUT. */
  body?: unknown;
  /** Extra query params (string values). The profile param is added centrally;
   * pass `scopeToProfile: false` to opt a non-profile endpoint out. */
  query?: Record<string, string | undefined>;
  /** Whether to attach `?profile=<target.profile>`. Defaults to true so
   * profile targeting is the default, not an afterthought. Set false for
   * endpoints Hermes does not scope by profile. */
  scopeToProfile?: boolean;
  /** Overrides the per-request timeout. */
  timeoutMs?: number;
  /** Suppresses ALL diagnostics for this request (success and error), even when
   * a logger is configured. Set for secret-returning endpoints such as
   * `POST /api/env/reveal`: the transport never logs response bodies anyway, but
   * this is belt-and-suspenders so such a call cannot be logged even if logging
   * is later widened. */
  silent?: boolean;
};

/**
 * A bound request function for one target. Use {@link createAdminTransport}; the
 * client module builds its method groups on top of the returned function.
 */
export type AdminTransport = <T>(
  request: AdminRequestInit,
  parse: (raw: unknown) => T,
) => Promise<T>;

/** Builds the request executor for a single {@link HermesAdminTarget}. */
export function createAdminTransport(
  target: HermesAdminTarget,
  options: AdminTransportOptions = {},
): AdminTransport {
  const doFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!doFetch) {
    throw new Error("No fetch implementation available for the admin client.");
  }
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.logger;

  return async function send<T>(
    request: AdminRequestInit,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const endpoint = `${request.method} ${request.path}`;
    // A `silent` request is never logged, even on error.
    const sink = request.silent ? undefined : log;
    const url = buildUrl(target, request);
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? defaultTimeout;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await doFetch(url, {
        method: request.method,
        // The token rides in the header, NEVER the URL, so a logged URL cannot
        // leak it. Content-Type matches the Rust bridge.
        headers: {
          "X-Hermes-Session-Token": target.token,
          "Content-Type": "application/json",
        },
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const adminError = HermesAdminError.from(endpoint, error);
      emit(sink, "error", endpoint, url, adminError, request.body);
      throw adminError;
    }
    clearTimeout(timer);

    const status = response.status;
    let text: string;
    try {
      text = await response.text();
    } catch {
      text = "";
    }

    if (!response.ok) {
      const adminError = new HermesAdminError({
        endpoint,
        kind: "http",
        status,
        code: extractErrorCode(text),
        rawBody: text,
      });
      emit(sink, "error", endpoint, url, adminError, request.body);
      throw adminError;
    }

    try {
      // Both a malformed body (JSON.parse fails) and a 2xx whose body fails our
      // defensive validator land here. Parsing is inside the try so the catch
      // labels EITHER failure with the real endpoint/status, not "(response)".
      const raw = parseJsonBody(text);
      const value = parse(raw);
      emit(sink, "ok", endpoint, url, { status }, request.body);
      return value;
    } catch (error) {
      // A 2xx with an unparseable or unexpected body is a contract break, not a
      // server error: surface it as `parse` with a redacted preview.
      const adminError = new HermesAdminError({
        endpoint,
        kind: "parse",
        status,
        rawBody: text,
        safeMessage: "Hermes returned an unexpected response.",
      });
      void error;
      emit(sink, "error", endpoint, url, adminError, request.body);
      throw adminError;
    }
  };
}

/** Builds the full request URL: base + path + profile + extra query, with every
 * value URL-encoded. The token is deliberately NOT added here. */
function buildUrl(
  target: HermesAdminTarget,
  request: AdminRequestInit,
): string {
  const params = new URLSearchParams();
  if (request.scopeToProfile !== false) {
    params.set("profile", target.profile || DEFAULT_HERMES_PROFILE);
  }
  if (request.query) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value !== undefined) params.set(key, value);
    }
  }
  const queryString = params.toString();
  return queryString
    ? `${target.baseUrl}${request.path}?${queryString}`
    : `${target.baseUrl}${request.path}`;
}

/** Parses a response body to `unknown`. An empty body becomes `null` (mirrors
 * the Rust bridge). Invalid JSON throws (a plain Error) so the caller's
 * surrounding try/catch re-labels it as a `parse` failure with the real
 * endpoint, status, and a redacted body preview. */
function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

/** Reads Hermes' own error `code` from an error body, when present, without
 * trusting the body for anything user-facing. */
function extractErrorCode(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const code = parsed.code ?? parsed.error_code ?? parsed.error;
    return typeof code === "string" && code.trim() ? code.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Emits a redacted diagnostics record. The URL is token-stripped, the request
 * body is structurally sanitized, and an error is logged via its log-safe view.
 * Nothing here can carry a secret in the clear. */
function emit(
  log: AdminLogger | undefined,
  outcome: "ok" | "error",
  endpoint: string,
  url: string,
  detail: HermesAdminError | { status?: number },
  requestBody: unknown,
): void {
  if (!log) return;
  log({
    scope: "hermes-admin",
    outcome,
    endpoint,
    url: redactUrl(url),
    ...(detail instanceof HermesAdminError
      ? { error: detail.toLogSafe() }
      : { status: detail.status }),
    ...(requestBody === undefined
      ? {}
      : { requestBody: redactForLog(requestBody) }),
  });
}
