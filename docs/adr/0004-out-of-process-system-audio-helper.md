---
status: accepted
date: 2026-07-01
---

# macOS system audio capture via an out-of-process helper

June captures macOS system audio (the "meeting" source) with a separate,
signed helper `.app` (`june-system-audio-recorder`, built from
`src-tauri/native/mac-system-audio-recorder/`) rather than in-process. The main
app launches it with `/usr/bin/open -n`, controls it with Unix signals
(`SIGUSR1`/`SIGUSR2` = pause/resume, `SIGTERM`/`SIGKILL` = stop), and observes
it by polling a `status.json` file (`ready` / `level` / `error` / `stopped`,
plus `--pid` / `--log`). The helper writes system audio to its own growing WAV.

## Why

- CoreAudio **process-tap** capture requires its own TCC "Screen & System Audio
  Recording" permission and a signing/entitlement context distinct from the
  microphone path. Isolating it in a helper keeps the two permission surfaces
  and failure modes apart.
- Process isolation protects the microphone capture: a crash or hang in the
  system-audio path cannot take down the recording, and stale helpers can be
  reaped (`terminate_existing_helpers`).
- File IPC + signals is cruder than a socket but robust and dependency-free; the
  helper only needs to expose start/pause/resume/stop and a readiness/level
  feed.

## Considered options

- **In-process CoreAudio tap** — rejected: couples the system-audio TCC grant
  and its crashes to the whole app and the mic path.
- **A socket / pipe control channel** — more moving parts than the control
  surface needs; file + signals is sufficient and easy to observe/debug.

## Consequences

- The `status.json` event schema and the signal semantics are a **wire
  contract** between `system_macos.rs` and `main.swift`; changing one without
  the other breaks capture. This contract is otherwise code-only — see
  [docs/audio-pipeline.md](../audio-pipeline.md).
- The helper must be **signed and bundled** with the app; readiness/probe
  timeouts (30s / 75s) gate whether system capture is offered.
- **macOS 14.2+** is required for process-tap capture; older systems fall back
  to microphone-only (`system-audio-min-macos-version.txt`).
