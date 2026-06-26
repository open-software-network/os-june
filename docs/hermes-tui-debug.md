# Raw Hermes TUI debug fallback

A developer-only escape hatch for isolating where a bug lives: in June's
adapter/UI layer, or in Hermes (the model, a tool, the runtime). It resumes the
**exact same session** June is showing in Hermes' own raw terminal UI, under the
**same sandbox/unrestricted profile** June used, so the only variable removed is
June's frontend.

This is not part of June's product UX. The menu item is gated to dev builds
(`import.meta.env.DEV`) and is absent from production.

## Where it is

Open a Hermes session, then the session bar's "..." menu. Below "Delete session"
(dev builds only): **Debug with Hermes TUI**.

## What it does

1. Resolves the same hermes binary, `HERMES_HOME`, and per-session mode the
   dashboard runtime uses (see `src-tauri/src/hermes_bridge.rs`).
2. Generates a launcher script and opens it in Terminal. The script:
   - echoes a trace line (`Hermes TUI debug: resuming June session <id> ...`),
   - exports the same isolated env as June's runtime, and
   - runs `hermes --tui --resume <session-id>`, wrapped in
     `sandbox-exec -f <profile>` when the session is sandboxed, bare when the
     session is unrestricted.

Because both June and this TUI resume the **same session id**, the terminal
window and the June session are provably the same session. The trace line is
also written to the app log (`eprintln!`) so the mapping survives the terminal
being closed.

macOS only. On other platforms the command returns
`hermes_tui_debug_unsupported`.

## Triage matrix

Run the same prompt/turn in the raw TUI that misbehaved in June.

| Symptom in June                                                          | Behaviour in TUI                                                                                                                   | Most likely cause                                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong/garbled output, missing events, stuck spinner, action not surfaced | **Works correctly in TUI**                                                                                                         | June adapter/UI bug. The event reached Hermes fine; June's classifier, gateway, or render dropped/mangled it. Look in `src/lib/hermes-control-plane/` and `AgentWorkspace.tsx`. |
| Error, refusal, bad tool call, model failure                             | **Fails the same way in TUI**                                                                                                      | Hermes / model / tool bug. June is faithfully relaying it. Reproduce against upstream Hermes and file there; June can't fix it in the adapter.                                  |
| Write/permission failure, tool blocked                                   | **Works unrestricted but fails sandboxed** (open the same session, which is sandboxed; if it works, retry an unrestricted session) | June policy/sandbox bug. The Seatbelt write-jail (`prepare_sandbox` in `hermes_bridge.rs`) is denying something it should allow, or the grants are too narrow.                  |

### Reading the mode

The TUI runs under the session's recorded mode (the same boolean
`sessionUnrestricted` drives in June). To compare sandboxed vs unrestricted, open
the debug TUI from a sandboxed session and from an unrestricted session and run
the same operation. If it only fails under the sandbox, the jail is the
suspect, not Hermes.

## Pure, testable core

The decision logic is isolated from process spawning so it stays unit-testable:

- `src/lib/hermes-tui-debug.ts` builds the `--tui --resume <id>` args, resolves
  the session->mode mapping, the trace line, and the dev gate. Tested in
  `src/test/hermes-tui-debug.test.ts`.
- `src-tauri/src/hermes_bridge.rs` holds `hermes_tui_resume_args` and
  `build_hermes_tui_debug_launcher_script` are pure; the spawn
  (`open_hermes_tui_debug` / `launch_hermes_tui_debug_terminal`) is the thin,
  environment-dependent shell around them. Tested under
  `hermes_bridge::tests::tui_*`.

The mode is deliberately **not** a CLI flag. The sandboxed/unrestricted split is
enforced by wrapping the spawn in `sandbox-exec`, exactly like the dashboard, so
the resume args are identical for both modes and a sandboxed session can never
be relaunched unrestricted by accident.
