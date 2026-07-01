/**
 * The production transport for the Hermes admin client. It satisfies the
 * transport's {@link FetchLike} contract but, instead of issuing a webview
 * `fetch`, routes every admin call through the Rust `hermes_admin_request`
 * command (reqwest, server-side).
 *
 * Why this exists: the Tauri webview (origin `http://localhost:1421`) is
 * cross-origin to the Hermes dashboard (`http://127.0.0.1:<port>`). The
 * dashboard sends no CORS headers and 401s the preflight, so a webview `fetch`
 * to `target.baseUrl` always fails with a network error — the installed Skills
 * page (and every other admin surface) could never load. Every other Hermes
 * call in June already avoids this by going through Rust; the foundation
 * transport was the lone webview-fetch surface. This adapter closes that gap.
 *
 * The adapter ignores `baseUrl`/`token`: the Rust side resolves both from the
 * selected bridge connection, so the dashboard token never has to reach the
 * webview. It DOES pass the explicit `mode` so Rust targets the chosen runtime
 * (sandboxed vs unrestricted) rather than "whichever connection is first" —
 * matching `adminTargetForMode` on the TS side.
 *
 * The transport reads only `response.status`, `response.ok`, and
 * `await response.text()` off the returned value, so a minimal Response-like
 * shape is all this returns. The injectable `invoke` keeps the adapter
 * unit-testable without a real Tauri runtime.
 */

import { invoke as tauriInvoke } from "../tauri";
import type { FetchLike } from "./transport";
import type { HermesAdminMode } from "./target";

/** The Tauri `invoke` surface this adapter needs. Injectable so a unit test can
 * assert the adapter routes through it without a Tauri runtime. */
export type AdminInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** The minimal Response-like object the transport consumes. */
type ResponseLike = {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
};

/** The Rust command this adapter calls. */
export const HERMES_ADMIN_REQUEST_COMMAND = "hermes_admin_request";

/**
 * Builds a {@link FetchLike} for one mode that routes through the Rust admin
 * proxy. `mode` selects the runtime explicitly (Rust never falls back to the
 * first connection). `invoke` defaults to the app's Tauri `invoke`; tests pass
 * a mock.
 */
export function createRustAdminFetch(
  mode: HermesAdminMode,
  invoke: AdminInvoke = tauriInvoke as AdminInvoke,
): FetchLike {
  return async function rustFetch(input, init): Promise<Response> {
    // The transport builds an absolute URL (`baseUrl + path + query`), but Rust
    // resolves the base from the bridge connection, so only the path-and-query
    // is forwarded. A relative input is used verbatim.
    const path = pathWithQuery(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = parseBody(init?.body);

    let raw: unknown;
    try {
      raw = await invoke(HERMES_ADMIN_REQUEST_COMMAND, {
        mode,
        method,
        path,
        body,
      });
    } catch (error) {
      // The Rust side (`hermes_connection_json`) turns a non-2xx Hermes response
      // into an Err whose message is `Hermes API returned <status>: <body>`.
      // That is an HTTP error, NOT an unreachable Hermes — surface it WITH its
      // real status so the transport reports the actual problem (e.g. a 422 the
      // install body tripped) instead of the misleading network-kind "Could not
      // reach Hermes". A genuine transport failure (bridge not running,
      // connection refused) carries no such status and is re-thrown, so it still
      // normalizes to `network`, exactly as a failed webview fetch would have.
      const httpError = parseHermesHttpError(toMessage(error));
      if (httpError) {
        return makeResponse(
          httpError.status,
          httpError.body,
          true,
        ) as unknown as Response;
      }
      throw error instanceof Error ? error : new Error(toMessage(error));
    }

    // Rust returns the parsed JSON value on a 2xx (or `null` for an empty body)
    // and throws on a non-2xx, so reaching here means success. Re-serialize so
    // the transport's `text()` + `JSON.parse` path is unchanged.
    return makeResponse(200, raw) as unknown as Response;
  };
}

/** Extracts `path + ?query` from an absolute or relative URL. */
function pathWithQuery(input: string): string {
  try {
    const url = new URL(input);
    return `${url.pathname}${url.search}`;
  } catch {
    // Already a relative path (no origin); forward as-is.
    return input;
  }
}

/** Parses the transport's JSON-string body back to a value for Rust. The
 * transport always `JSON.stringify`s its bodies, so a string is parsed; a
 * missing body becomes `undefined` (no request body). */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return body;
    }
  }
  return body;
}

/** A minimal Response-like over a value. Only `status`, `ok`, and `text()` are
 * read by the transport. On the 2xx path `value` is a parsed JSON value that is
 * re-serialized; on the error path (`rawText`) `value` is Hermes's already-
 * serialized error body, passed through untouched so the transport's
 * `extractErrorCode` / rawBody preview see exactly what Hermes returned. */
function makeResponse(
  status: number,
  value: unknown,
  rawText = false,
): ResponseLike {
  const text = rawText
    ? typeof value === "string"
      ? value
      : String(value ?? "")
    : value === null || value === undefined
      ? ""
      : JSON.stringify(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(text),
  };
}

/** Parses the Rust proxy's non-2xx error message (`Hermes API returned
 * <status>: <body>`) into its status + raw body. Returns null for any other
 * failure (bridge not running, connection refused), which stays a `network`
 * error rather than being mislabeled as an HTTP response. */
function parseHermesHttpError(
  message: string,
): { status: number; body: string } | null {
  const match = /Hermes API returned (\d{3})[^:]*:\s?([\s\S]*)$/.exec(message);
  if (!match) return null;
  return { status: Number(match[1]), body: match[2] ?? "" };
}

function toMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Hermes admin request failed.";
}
