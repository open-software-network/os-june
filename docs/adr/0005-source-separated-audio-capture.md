---
status: accepted
date: 2026-07-01
---

# One WAV per source, re-interleaved as turns

Meeting recordings capture the microphone and system audio to **separate WAV
files** (`microphone.wav`, `system.wav`), never a mixed track. Each source is
validated and transcribed independently, and the two transcripts are woven back
together only as ordered **turns**. During capture each file is written as
`*.partial.wav` and **atomically renamed** to `*.wav` on a clean finalize — the
rename is the durability commit point.

## Why

- **Independent validation and recovery**: a silent or corrupt system source
  can be dropped (`drop_silent_system_sources`) without poisoning the mic
  source.
- **Source-labeled transcripts**: keeping lanes separate is what lets the note
  attribute speech to microphone (the user) vs system (a remote participant).
- **Crash-safety without a journal**: recovery scans the bytes on disk, and the
  finalized filename only appears after a clean finalize, so partially written
  audio is never mistaken for a complete artifact. Bytes on disk win over DB
  status.

## Trade-off

- Loses exact cross-source **sample alignment** — the two files are not
  guaranteed sample-synchronous, so the only cross-source join is
  energy-detected **turns** (`start_ms` ordering), not a single mixed timeline.
- Turn detection is energy-based (RMS windows + a noise floor), with **no
  diarization** — speaker identity within a source is out of scope.

## Consequences

- **Turns are the sole cross-source reconciliation** point. Attribution bugs
  live there — e.g. a remote participant bleeding from the speakers into the mic
  produced false microphone turns until speaker-echo trimming was added.
- Recovery, validation, and the WAV writer are **coupled around the
  atomic-rename contract**; changing the finalize/rename flow means updating all
  three.
- See [ADR-0004](0004-out-of-process-system-audio-helper.md) for how the system
  source is captured and [docs/audio-pipeline.md](../audio-pipeline.md) for the
  turn-detection algorithm.
