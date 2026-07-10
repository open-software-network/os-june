# Persona recognition Phase 1 spike

> PROTOTYPE - throw this code away or absorb the validated parts after the
> Phase 1 decision. It is not part of June's production binary.

## Question

Can local diarization split June's saved System source audio into useful speaker
clusters, and do embeddings re-extracted from those clusters separate the same
person across meetings from different people well enough to support the
suggest/auto confidence bands?

Run the public-fixture smoke path with one command:

```bash
pnpm persona:spike -- --smoke
```

Run the real quality spike with at least two saved WAVs from different
recordings:

```bash
pnpm persona:spike -- /path/to/first/system.wav /path/to/second/system.wav
```

The command downloads pinned models and native sherpa artifacts into the
gitignored `.persona-spike/` directory. It performs inference locally, writes
per-cluster listening WAVs under `.persona-spike/output/`, and asks for a human
label for each cluster. Use the same spelling for the same person across files;
leave the label blank for an unknown cluster or enter `mixed` when a cluster
contains more than one person.

The JSON report contains timings, labels, and aggregate score distributions.
It never contains embedding vectors or audio bytes. Input audio is never
uploaded. The public smoke fixture proves mechanics only; the PRD gate requires
real `system.wav` recordings from different meetings and devices.

For a repeatable non-interactive real-audio run, pass `--labels labels.json`.
The outer JSON keys are zero-based input positions in the command and the inner
keys are diarized speaker indices, so recordings with the same `system.wav`
basename cannot collide:

```json
{
  "0": { "1": "James" },
  "1": { "1": "James", "2": "Priya" }
}
```

A quality PASS requires distinct WAV contents, at least one labeled and
embeddable cluster from every evaluation recording, every evaluation cluster
to be labeled, no cluster marked `mixed`, no identity split across multiple
clusters in one recording, an embedding for every labeled cluster, and complete
separation between the observed genuine and impostor scores. Mixed or
fragmented diarization fails; non-contributing recordings, unknown clusters,
or missing score pairs make the result inconclusive.

## Runtime choice

The spike uses `sherpa-onnx` 1.13.4 because its current Rust API exposes both
offline speaker diarization and reusable speaker embeddings, and it publishes
native artifacts for macOS arm64/x86_64 and Windows x86_64. The wrapper pins
and verifies the selected native archive before Cargo can use it. The verified
model paths are appended after caller arguments so they cannot be overridden,
and their hashes are recorded in the report. A build script rejects the
native-library override, re-hashes the selected archive, and embeds that
verified provenance into the binary's report. The high-level
diarizer returns speaker segments, not embeddings, so this prototype
re-extracts one normalized embedding from each cluster. The isolated lockfile
pins `url` 2.5.2 and `zeroize` 1.8.1 so the graph remains compatible with
June's Rust 1.80 minimum; `cargo +1.80.0 check --locked` passes.
Use the pnpm command above, not a direct `cargo run`: the wrapper supplies the
verified native archive and the binary refuses to run without that evidence.

Alternatives remain useful baselines but are not the production-shaped first
choice:

- `speakrs` 0.5.0 exposes richer diarization embeddings, but requires Rust
  1.88, has no proven Windows release path, and its aggregate model repository
  does not declare a model license.
- `pyannote-rs` 0.3.4 is smaller, but June would own more clustering,
  score-return, persistence, and provider setup around it.

The selected segmentation weights derive from `pyannote/segmentation-3.0`
(MIT). The embedding weights derive from
`pyannote/wespeaker-voxceleb-resnet34-LM` (CC BY 4.0). They are downloaded for
local evaluation and are not committed or bundled. Production redistribution
must preserve attribution and license texts and verify the provenance of the
converted ONNX assets.

## Production seam and remaining gates

If the quality gate passes, persona recognition composes with
`process_saved_source_audio` after `detect_turns_with_report` and before turn
WAV extraction/note transcription. It annotates or subdivides detected turns; it
does not change energy-based turn detection.

Before shipping, prove all of the following:

- real cross-meeting quality and per-lane thresholds;
- universal macOS packaging from per-architecture native archives;
- Windows build, runtime loading, and installer footprint;
- model attribution, redistribution, pinning, and smoke gates.
