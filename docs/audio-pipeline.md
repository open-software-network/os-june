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
2. Per input callback: write 16-bit PCM, update `CaptureStats`, and
   non-blockingly feed the **live preview** sink (a bounded channel) — a worker
   transcribes ~8s chunks and emits ephemeral `live-transcript-event`s that are
   **never persisted**.
3. **`finish_recording`** finalizes the writer, atomically renames
   `*.partial.wav` → `*.wav` (the durability commit), stops the helper, cancels
   preview.
4. **`process_saved_source_audio`** (`src-tauri/src/domain/processing.rs`) runs
   the batch pipeline: `drop_silent_system_sources` → `turns::detect_turns` →
   `coalesce_turns_for_transcription` → `write_turn_wav` (seek-extract each turn)
   → `normalize_wav_for_transcription` → `split_wav_for_transcription` (≤30-second
   chunks) → `transcribe_saved_audio` (POST `/v1/notes/transcribe`, provider
   routing is server-side) → persist per-source transcript rows → **note
   generation**. If a source lane has materially incomplete transcript coverage,
   June retries the saved full source in bounded chunks and replaces the partial
   turn rows when that fallback succeeds.

## Key files

- `src-tauri/src/audio/capture.rs` — mic capture, `CaptureStats`, the single
  global `ACTIVE_RECORDING` (one recorder at a time).
- `src-tauri/src/audio/system_macos.rs` + `native/mac-system-audio-recorder/
  main.swift` — the system-audio helper and its readiness/permission probes.
- `src-tauri/src/audio/turns.rs` — turn detection, coalescing, WAV extraction,
  normalization, chunking, per-source configs.
- `src-tauri/src/audio/live_preview.rs` — mic/system preview workers, the
  `WavTailReader` that tails the helper's growing WAV.
- `src-tauri/src/audio/{validation,recovery}.rs` — artifact validation and
  crash recovery.

Tauri commands: `start_recording`, `pause_recording`, `resume_recording`,
`get_recording_status`, `finish_recording`, `check_recording_source_readiness`,
`recover_recording`, `get_microphone_permission_state`.

## System-audio helper IPC contract

The helper is controlled and observed out-of-process (see ADR-0004):

- **Control:** Unix signals — `SIGUSR1` / `SIGUSR2` = pause / resume,
  `SIGTERM` / `SIGKILL` = stop. Launched via `/usr/bin/open -n`.
- **Observation:** a `status.json` file with events `ready` / `level` / `error`
  / `stopped` (fields include `level` / `maxLevel` / `message`).
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
- Turns are ordered purely by `start_ms` / `turn_index`.
- **Speaker-echo trimming:** because the two sources are not captured through a
  single mixer, a remote participant's voice bleeding from the speakers into the
  mic can raise a false microphone turn. The detector trims the system-dominated
  spans out of a mic turn (keeping the genuine remainder) rather than dropping
  the whole turn, so a user's reply that merged with an echo survives.

## Normalization and chunking

Before transcription each turn WAV is downmixed to **mono**, resampled to
**16 kHz**, and gain-adjusted toward a target peak (bounded, with a
reuse-original shortcut when already loud enough), then split into
**≤30-second** chunks with rolling context.

## Recovery

`scan_recoverable_recordings` reads `recording_sessions` + `audio_artifacts`.
The governing rule: **bytes on disk win over DB status** — the mic WAV is
flushed periodically and the finalized filename only appears after a clean
finalize, so a crash leaves replayable audio that recovery can finish
processing.
