/**
 * Who an admin request talks to. June can run TWO Hermes runtime processes at
 * once (sandboxed + unrestricted, see `hermes_bridge.rs`), and a profile/mode-
 * sensitive write (toggle a skill, add an MCP server, set an env value) MUST be
 * aimed at a chosen one — never "whichever connection happens to be first".
 * Implicitly targeting the first connection is the exact class of bug the chat
 * layer had: June mutates the wrong runtime and shows wrong state.
 *
 * A {@link HermesAdminTarget} is therefore a self-contained, explicit address:
 * base URL, auth token, the mode flags, the Hermes home, and the selected
 * profile id. The client is constructed from ONE target. To pick a target from
 * a bridge status, the caller uses a NAMED selector here
 * ({@link adminTargetForMode} / {@link adminTargetForCurrentMode}) so the choice
 * is visible in the code and reviewable, not buried in the transport.
 */

import type { HermesBridgeConnection, HermesBridgeStatus } from "../tauri";

/** Hermes' per-runtime write-access mode, mirroring the control plane's
 * `HermesMode`. `sandboxed` is the safe default; `unrestricted` is Full mode. */
export type HermesAdminMode = "sandboxed" | "unrestricted";

/**
 * The explicit address of the Hermes runtime an admin client manages. Built
 * from a {@link HermesBridgeConnection} plus an optional profile. Carrying the
 * mode flags lets the client surface June's sandbox/full-mode model wherever a
 * change touches local subprocesses, stdio MCP servers, scripts, or external
 * directories.
 */
export type HermesAdminTarget = {
  /** Dashboard base URL, e.g. `http://127.0.0.1:54321`. No trailing slash. */
  baseUrl: string;
  /** Dashboard session token, sent as `X-Hermes-Session-Token`. Never logged. */
  token: string;
  /** This runtime's write-access mode, derived from the connection. */
  mode: HermesAdminMode;
  /** True when this runtime is opted into Full mode (sandbox deliberately off). */
  fullMode: boolean;
  /** True when the macOS Seatbelt write-jail is actually in force. */
  sandboxed: boolean;
  /** The Hermes home this runtime uses; identifies the on-disk profile root. */
  hermesHome: string;
  /** Selected Hermes profile id for endpoints that scope by profile. June only
   * provisions the root profile today, so this defaults to `"default"`. */
  profile: string;
};

/** June only ever provisions the root Hermes profile (see the cron pinning in
 * `hermes_bridge.rs`); admin requests scope to it unless a caller overrides. */
export const DEFAULT_HERMES_PROFILE = "default";

/** Strips a trailing slash so `baseUrl + "/api/..."` never doubles up. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** The mode label for a connection: a runtime is `unrestricted` only when Full
 * mode is on; everything else (including an environmentally-unsandboxed default
 * runtime) is treated as `sandboxed` for the purpose of mode display. */
export function modeForConnection(
  connection: HermesBridgeConnection,
): HermesAdminMode {
  return connection.fullMode ? "unrestricted" : "sandboxed";
}

/**
 * Builds a target from a specific bridge connection. This is the explicit,
 * always-correct path: the caller has already chosen the connection.
 */
export function adminTargetFromConnection(
  connection: HermesBridgeConnection,
  profile: string = DEFAULT_HERMES_PROFILE,
): HermesAdminTarget {
  return {
    baseUrl: normalizeBaseUrl(connection.baseUrl),
    token: connection.token,
    mode: modeForConnection(connection),
    fullMode: connection.fullMode,
    sandboxed: connection.sandboxed,
    hermesHome: connection.hermesHome,
    profile: profile.trim() || DEFAULT_HERMES_PROFILE,
  };
}

/**
 * Selects the connection for a given mode from a bridge status and builds its
 * target. Returns `undefined` when no runtime is up in that mode. This is the
 * named selector profile/mode-sensitive callers MUST use instead of reaching
 * for `status.connections[0]`.
 */
export function adminTargetForMode(
  status: HermesBridgeStatus,
  mode: HermesAdminMode,
  profile: string = DEFAULT_HERMES_PROFILE,
): HermesAdminTarget | undefined {
  const wantFull = mode === "unrestricted";
  // A connection is only targetable once it carries a base URL. Production
  // connections always do, but a partially-populated status (e.g. a runtime
  // still coming up) must yield "no target" rather than crash a render-path
  // caller like the skill-review hook on `undefined.replace`.
  const connection = (status.connections ?? []).find(
    (candidate) =>
      candidate.fullMode === wantFull && Boolean(candidate.baseUrl),
  );
  return connection
    ? adminTargetFromConnection(connection, profile)
    : undefined;
}

/**
 * The well-named default the spec calls for: the target for the CURRENT
 * session's mode. The caller passes the mode it is operating in (the same
 * `HermesMode` the chat layer already tracks per session), so the choice stays
 * explicit — this helper still refuses to invent a connection, returning
 * `undefined` when that mode is not running rather than silently falling back to
 * the other runtime.
 */
export function adminTargetForCurrentMode(
  status: HermesBridgeStatus,
  currentMode: HermesAdminMode,
  profile: string = DEFAULT_HERMES_PROFILE,
): HermesAdminTarget | undefined {
  return adminTargetForMode(status, currentMode, profile);
}

/** A stable, non-secret identity string for a target, used as the prefix of
 * every cache resource key so data from one profile/mode can never be read
 * under another. Deliberately excludes the token. */
export function targetKey(target: HermesAdminTarget): string {
  return `${target.mode}:${target.profile}:${target.baseUrl}`;
}
