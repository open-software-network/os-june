# ADR 0038: Derive Microphone noise suppression input after Turn detection

Date: 2026-07-24
Status: proposed, held for product and quality approval

## Context

Microphone recordings can contain fans, rain, keyboard impacts, and other
ambient noise that reduces note-transcription quality. The finalized Source WAV
is June's recovery and replay authority. Rewriting it would make suppression
irreversible and could permanently damage speech.

Noise suppression can also change the energy and similarity evidence used for
Turn detection and speaker-bleed trimming. Applying it before those stages
could move timestamps or change Source attribution. Applying it independently
to every Turn would repeat work during retries and could produce inconsistent
overlap boundaries.

Offline neural suppression is generally stronger on keyboard-like transients,
but adding a new audio-model crate is a separate supply-chain and product
decision. June needs a reviewable pipeline boundary without assuming that
approval.

## Decision

Microphone noise suppression is an optional, persisted setting that defaults
off. It runs locally after raw Source Turn detection and speaker-bleed trimming,
but before Turn extraction, normalization, and transcription. System audio does
not pass through suppression.

June derives one full-length mono 16 kHz WAV beside the finalized recording in
a private `.june-transcription-input` cache. The cache key includes the
finalized input content and denoiser version. The derived file is written
atomically and reused by retry. Only downstream Microphone `source_path` values
are replaced; Source identities, Turn bounds, and the finalized WAV remain
unchanged.

The processing boundary is a small `Denoiser` trait whose `process` method
mutates one normalized `f32` frame. Implementations declare their sample rate,
frame length, and hop length. Suppression failure leaves paths unchanged,
records a Microphone-specific warning checkpoint, and continues with the
finalized WAV. The durable job configuration fingerprint includes the actual
derived, clean-bypass, or raw-fallback outcome. A later successful derivation
therefore cannot reuse text produced during an earlier raw fallback.

Until a neural dependency is approved, June ships an interim implementation
using the existing FFT dependency. A first streaming pass estimates the noise
floor and stationary spectrum. A second pass applies conservative spectral
subtraction with temporal and frequency smoothing, a gain floor, and a
clean-input bypass.

`nnnoiseless` 0.5.2 is the recommended future implementation of this seam. It
is a pure-Rust RNNoise port under BSD-3-Clause, released 2025-12-18, and is
older than the repository's seven-day dependency cooldown. It is not added by
this decision. Approval would add an `RnnoiseDenoiser` behind the existing
trait, with no archive or orchestration change.

## Consequences

- Users can disable suppression when it harms a voice or microphone.
- Capture callbacks and finalized recording writes are unchanged.
- Raw evidence determines Source attribution and Turn timestamps.
- Retries reuse deterministic derived input and configuration fingerprints
  invalidate completed jobs when suppression is enabled.
- The no-dependency fallback primarily helps steady noise. It is not expected
  to match a neural suppressor on keyboard-like transients.
- Product acceptance remains held until the user chooses gate-only or approves
  the neural dependency and reviews measured audio and transcription impact.

## 2026-07-24 review addendum: cost boundaries

The deterministic derived path is a transient cache, not a second retained
recording. Its cleanup token shares the existing Turn-WAV lifetime guard, so
the file remains available through blocking Turn preparation, provider work,
and transcript-coverage calculation, including when the caller is cancelled.
It is deleted after those consumers drain, and the private cache directory is
removed when empty. A completed derivative left by a process crash can still
be reused by Retry and is then removed through the same guard.

The durable configuration fingerprint records suppression only when the
denoiser actually produced a different transcription input. Clean bypass and
raw fallback both use the suppression-off fingerprint because the provider
receives the same audio bytes. This prevents a setting toggle from causing a
billed re-transcription of byte-identical clean audio while still invalidating
cached text whenever suppression was applied.

## Rejected alternatives

- **Rewrite the finalized Microphone WAV.** This destroys the recovery
  authority and makes suppression harm irreversible.
- **Suppress in the capture callback.** This adds real-time work to a
  deliberately allocation-free path and bakes the result into the archive.
- **Suppress before Turn detection.** This can change timestamps and
  speaker-bleed attribution.
- **Use platform voice-isolation APIs.** Availability and behavior differ
  across supported macOS and Windows versions, weakening deterministic
  cross-platform retry behavior.
- **Use only a hard noise gate.** Hard thresholds clip quiet speech and do
  little for noise overlapping speech.
- **Add a bundled heavyweight model.** The footprint and deployment cost are
  disproportionate to this stabilization change.
