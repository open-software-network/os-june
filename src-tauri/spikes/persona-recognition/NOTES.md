# Spike result

Status: public-fixture mechanics passed; awaiting execution on real June
`system.wav` recordings.

Public fixture run on 2026-07-09 (`pnpm persona:spike -- --smoke`):

- `sherpa-onnx` 1.13.4, CPU provider;
- segmentation model: 5,992,913 bytes;
- embedding model: 26,530,550 bytes;
- three cross-recording genuine pairs: 0.8719 to 0.9191;
- twelve cross-recording impostor pairs: 0.7106 to 0.8405;
- observed public-fixture ballparks: suggest 0.8405, auto 0.8719;
- per-file real-time factor: 0.026 to 0.041 on Apple Silicon;
- the locked dependency graph passes `cargo +1.80.0 check --locked`;
- one 2.98-second single-speaker clip fragmented into a second 0.30-second
  anonymous cluster.

The harness returned PASS because max impostor was below min genuine. This is
a mechanics result over clean, single-speaker public clips, not the PRD quality
gate and not a production threshold. The next run must use compressed June
remote-lane recordings from different meetings/devices and the operator must
listen for mixed or fragmented clusters.

Do not advance the production implementation from this placeholder. Phase 1
stays gated until real recordings show a clean enough score separation and the
diarized listening WAVs are not materially mixed or fragmented.
