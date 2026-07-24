# Audio pipeline — capture to note

How June records meeting audio, separates sources, detects conversation turns,
and transcribes into a note. It is **saved-audio-first**: the local WAV is the
source of truth, provider speed is secondary. See
[ADR-0005](adr/0005-source-separated-audio-capture.md) (one WAV per source),
[ADR-0004](adr/0004-out-of-process-system-audio-helper.md) (system-audio
helper), and [ADR-0002](adr/0002-live-transcript-preview-strategy.md) (live
preview).

## Data flow

1. **`start_recording`** → `capture::start_capture` opens `microphone.partial.wav`
   (a CPAL input stream) and, in meeting mode, starts the system-audio helper
   writing `system.partial.wav`.
2. Per input callback: convert samples to 16-bit PCM, update lock-free level
   atomics, and publish fixed-size blocks into a preallocated bounded audio
   ring. The callback allocates nothing, takes no locks, and performs no I/O.
   A dedicated non-real-time task drains the ring into the WAV writer and
   non-blockingly feeds the **live preview** sink; its worker transcribes ~8s
   chunks and emits ephemeral `live-transcript-event`s that are **never
   persisted**. The ring holds 30 seconds at the configured sample rate and
   channel count, with a memory cap for unusual high-channel devices. If disk
   writing ever falls more than that capacity behind, the oldest queued blocks
   are dropped, exact dropped-sample counts appear in recording status, and
   recovery/finalization checkpoints persist the count. Writer progress is
   tracked separately from callback production: `bytesWritten` advances only
   after successful WAV writes. The first writer I/O error, panic, unexpected
   exit, or sustained stall stops the drain and immediately enters the existing
   microphone warning path; recovery checkpoints persist its diagnostic code.
   Each queued block also carries its callback generation, so overflow cannot
   merge surviving live-preview audio across a dropped callback boundary.
3. **`finish_recording`** stops the input stream, drains and finalizes the
   writer task, then atomically renames
   `*.partial.wav` → `*.wav` (the durability commit), stops the helper, cancels
   preview. Completed microphone byte metadata is replaced from the writer
   watermark returned after that final drain.
4. **`process_saved_source_audio`** (`src-tauri/src/domain/processing.rs`) runs
   the batch pipeline for microphone-only and dual-Source recordings:
   `drop_silent_system_sources` → dual-Source `turns::detect_turns` (or one
   authoritative full-Source microphone job) → optional derived Microphone
   noise suppression → reconcile durable fingerprinted note-transcription jobs
   → bounded Turn preparation → one
   in-flight provider request per Source → atomically persist each successful
   job and transcript row → **note generation**. Full-Source fallbacks are
   prepared lazily when a Source is materially incomplete and atomically
   replace that Source's partial rows only after the replacement succeeds.

While capture is active, the native meeting-HUD supervisor samples capture at
10 Hz and emits the additive `recording-telemetry` Tauri event. Its narrow
payload carries the recording session id, state, elapsed time, audio levels,
and live warnings; both the main renderer and meeting HUD subscribe to that
single stream. In the main renderer, the latest sample stays in a narrow
external store: waveform subscribers receive level samples at 10 Hz, elapsed
time subscribers publish only on whole-second boundaries, and the root App
reducer receives only lifecycle, Source-health, and actionable-warning changes.
Stable metadata still comes from the recording commands, and
`get_recording_status` remains available as a read-only compatibility command.
Recovery durability is independent of telemetry: a recording-scoped worker
requests a ring watermark flush and checkpoints elapsed time every 500 ms after
the recording rows are created. The WAV task drains through that watermark and
flushes the WAV before the recovery row advances. A dead writer releases the
flush wait so recovery state and diagnostics continue advancing instead of
waiting for the full timeout.

## Key files

- `src-tauri/src/audio/capture.rs` — mic capture lifecycle and the single
  global `ACTIVE_RECORDING` (one recorder at a time).
- `src-tauri/src/audio/capture_buffer.rs` — preallocated audio ring, atomic
  capture telemetry, recovery flush protocol, and non-real-time WAV drain.
- `src-tauri/src/audio/system_macos.rs` + `native/mac-system-audio-recorder/
  main.swift` — the system-audio helper and its readiness/permission probes.
- `src-tauri/src/audio/turns.rs` — turn detection, coalescing, WAV extraction,
  normalization, chunking, per-source configs.
- `src-tauri/src/audio/noise_suppression.rs` - optional, cached Microphone
  transcription input and the replaceable frame-level denoiser seam.
- `src-tauri/src/audio/live_preview.rs` — mic/system preview workers, the
  `WavTailReader` that tails the helper's growing WAV.
- `src-tauri/src/audio/{validation,recovery}.rs` — artifact validation and
  crash recovery.

Tauri commands: `start_recording`, `pause_recording`, `resume_recording`,
`get_recording_status`, `finish_recording`, `check_recording_source_readiness`,
`recover_recording`, `get_microphone_permission_state`. Event:
`recording-telemetry`.

## System-audio helper IPC contract

The helper is controlled and observed out-of-process (see ADR-0004):

- **Control:** Unix signals — `SIGUSR1` / `SIGUSR2` = pause / resume,
  `SIGTERM` / `SIGKILL` = stop. Launched via `/usr/bin/open -n`.
- **Observation:** a `status.json` file with events `ready` / `level` / `error`
  / `stopped` (fields include `level` / `maxLevel` / `message`).
- **Routing:** a private stereo process tap is bound to the current default
  system output device, so it records the same device stream the user hears.
  The private aggregate contains the tap only; adding a physical output
  subdevice can create an output-only IO cycle with no tap callbacks. The helper
  performs at most one full-graph rebuild for missing callbacks or zero-filled
  buffers. If callbacks still stall or remain zero-filled after that rebuild,
  the helper reports the system source unavailable instead of silently writing
  a meeting-length silent WAV or entering a restart loop. Ordinary sustained
  silence remains subject to the saved-audio speech gate below.
- **CLI:** `--output` / `--status` / `--pid` / `--log`.
- **Timeouts:** ~30s readiness, ~75s probe. **macOS 14.2+** required for
  CoreAudio process taps; older systems get microphone-only.

## Turn detection

Energy-based, per-source, **no diarization**:

- 30 ms RMS windows; the activity threshold is the ~20th-percentile window
  energy times a per-source `noise_multiplier` (separates speech from
  background).
- Hysteresis: `start_active_ms` / `end_silence_ms` / `min_turn_ms` /
  `merge_gap_ms`, with separate microphone vs system config tables
  (`config_for_source`).
- Pre-provider silence checks require at least 180 ms of consecutive activity;
  one loud device-start window cannot certify an otherwise silent Source.
- Turns are ordered purely by `start_ms` / `turn_index`.
- **Speaker-echo trimming:** because the two sources are not captured through a
  single mixer, a remote participant's voice bleeding from the speakers into the
  mic can raise a false microphone turn. The detector trims the system-dominated
  spans out of a mic turn (keeping the genuine remainder) rather than dropping
  the whole turn, so a user's reply that merged with an echo survives.

## Normalization and chunking

When **Microphone noise suppression** is enabled, June first derives a mono
16 kHz Microphone WAV through a bounded-memory two-pass process. This happens
after Turn detection and speaker-bleed trimming, so source attribution,
timestamps, and System audio are unchanged. The finalized Microphone WAV is
never modified. A content-and-version fingerprint can reuse a completed
derivative after an interrupted attempt. The derived WAV shares the transient
Turn-audio lifetime guard and is removed after transcription and coverage
consumers drain. Derivation failure records a Source warning checkpoint and
falls back to the finalized WAV.

Only an actually applied derivative changes the durable transcription
configuration fingerprint. A clean bypass or raw fallback keeps the
suppression-off identity because transcription receives the same audio bytes,
so toggling the setting cannot bill for a byte-identical clean recording.

The interim implementation estimates a stationary noise spectrum from the same
low-percentile noise-floor principle used by Turn detection, then applies
smoothed spectral subtraction with a gain floor. It is deliberately
conservative and bypasses clean inputs. It is more effective for steady room
noise than short keyboard-like transients. The `Denoiser` frame interface lets
a stronger offline implementation replace it without changing archive,
pipeline, or persistence contracts.

Before transcription each turn WAV is downmixed to **mono**, resampled to
**16 kHz**, and gain-adjusted toward a target peak (bounded, with a
reuse-original shortcut when already loud enough). Normalization uses two
streaming passes over bounded raw-sample chunks: the first computes the
downmixed peak and sample count, and the second carries one global linear
resampler position across chunks while applying gain and writing incrementally.
Its working memory is fixed regardless of recording duration, and its global
resampler position preserves the historical whole-buffer output byte for byte.
The normalized WAV is then split into **≤30-second** chunks with rolling
context.

## Recovery

`scan_recoverable_recordings` reads `recording_sessions` + `audio_artifacts`.
The governing rule: **bytes on disk win over DB status** — the mic WAV is
flushed periodically and the finalized filename only appears after a clean
finalize, so a crash leaves replayable audio that recovery can finish
processing. Durable note-transcription jobs record exact Source spans and
attempt state; interrupted `running` jobs return to `pending`, and explicit
Retry resumes only jobs whose fingerprint has not already succeeded.
