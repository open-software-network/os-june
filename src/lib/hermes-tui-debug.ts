/**
 * Developer-only fallback that opens a June session in Hermes' own raw TUI, so
 * a developer can drive the exact same session id outside June's adapter and
 * see whether a bug lives in June's UI/adapter layer or in Hermes itself.
 *
 * This is a DEBUG tool, never part of June's product UX. It is gated to dev
 * builds (`import.meta.env.DEV`) and hidden in production.
 *
 * The honest division of labour, mirroring the dashboard spawn in
 * `src-tauri/src/hermes_bridge.rs`:
 *
 * - This module owns the PURE, unit-testable decisions: the CLI arguments
 *   (`hermes --tui --resume <id>`), the session->mode mapping, the trace line
 *   that ties the raw TUI session back to the June session id, and the dev
 *   gate. No process is spawned here.
 * - The Rust command `open_hermes_tui_debug` owns the environment-dependent
 *   half: it re-resolves the hermes binary, `HERMES_HOME`, and the Seatbelt
 *   write-jail for the session's mode, then launches the TUI in a terminal.
 *
 * Mode (sandboxed vs unrestricted) is deliberately NOT a CLI flag. June's
 * per-session mode is enforced by wrapping the spawn in `sandbox-exec` on the
 * Rust side exactly like the dashboard — so the args stay mode-independent and
 * the same session always resumes under the same jail it ran under in June.
 */

import {
  type HermesMode,
  hermesModeFor,
  hermesModeFromUnrestricted,
} from "./hermes-control-plane";

/** Which interactive shell to open. `tui` is the modern Hermes TUI; `repl` is
 * the classic prompt_toolkit REPL (`--cli`), kept as an escape hatch for when
 * the TUI itself is the thing under suspicion. */
export type HermesTuiInterface = "tui" | "repl";

export type BuildHermesTuiResumeArgsInput = {
  /** The June (== Hermes) session id to resume. */
  sessionId: string;
  /** Defaults to the modern TUI. */
  interface?: HermesTuiInterface;
};

/**
 * Builds the bare `hermes` argument vector that resumes a session in the raw
 * TUI. Pure: the args never encode the sandbox mode (that is applied at spawn),
 * so this is the same vector whether the session is sandboxed or unrestricted.
 *
 * Throws on a blank session id — resuming "the most recent" session would
 * silently break the trace link this whole feature depends on.
 */
export function buildHermesTuiResumeArgs(
  input: BuildHermesTuiResumeArgsInput,
): string[] {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error(
      "A session id is required to resume a Hermes TUI debug session.",
    );
  }
  const interfaceFlag = input.interface === "repl" ? "--cli" : "--tui";
  return [interfaceFlag, "--resume", sessionId];
}

/**
 * The session->TUI trace mapping, logged so a developer can correlate the raw
 * TUI session window with the June session it was launched from. Both halves
 * resume the same id, so this line is the proof they are the same session.
 */
export function hermesTuiDebugTraceLine(input: {
  sessionId: string;
  mode: HermesMode;
}): string {
  return `Hermes TUI debug: resuming June session ${input.sessionId} in raw TUI (${input.mode} mode). Same session id, same profile as June.`;
}

export type ResolveHermesTuiDebugLaunchInput = {
  /** The June (== Hermes) session id to resume. */
  sessionId: string;
  /** Whether this session opted into Unrestricted mode. Absence (or unknown)
   * is treated as sandboxed, the safe default. */
  unrestricted?: boolean;
  /** Defaults to the modern TUI. */
  interface?: HermesTuiInterface;
};

export type HermesTuiDebugLaunch = {
  sessionId: string;
  /** The mode the raw TUI must run under to match the June session. */
  mode: HermesMode;
  /** The bare `hermes` arg vector (mode applied at spawn, not here). */
  args: string[];
  /** The session->TUI trace line for the developer. */
  traceLine: string;
};

/**
 * Maps a June session onto a complete, honest TUI debug launch plan: the
 * resume args, the mode the spawn must enforce, and the trace line. Pure —
 * spawning is the Rust command's job. Resolves the mode the same way the rest
 * of the control plane does, so a sandboxed session can never be relaunched
 * unrestricted by accident.
 */
export function resolveHermesTuiDebugLaunch(
  input: ResolveHermesTuiDebugLaunchInput,
): HermesTuiDebugLaunch {
  const mode: HermesMode =
    input.unrestricted === undefined
      ? hermesModeFor(input.sessionId)
      : hermesModeFromUnrestricted(input.unrestricted);
  const args = buildHermesTuiResumeArgs({
    sessionId: input.sessionId,
    interface: input.interface,
  });
  // args[2] is the trimmed session id from buildHermesTuiResumeArgs.
  const sessionId = args[2];
  return {
    sessionId,
    mode,
    args,
    traceLine: hermesTuiDebugTraceLine({ sessionId, mode }),
  };
}

/** Whether the raw-TUI debug fallback is exposed. Dev builds only; the menu
 * item is absent from production builds. */
export function hermesTuiDebugAvailable(): boolean {
  return import.meta.env.DEV;
}

/** Plain-language warning shown next to the action so no one mistakes the raw
 * TUI for June's product surface. No dashes (project copy rule). */
export const HERMES_TUI_DEBUG_WARNING =
  "Developer debug tool. Opens this session in Hermes' raw terminal UI outside June. Not June's primary interface.";
