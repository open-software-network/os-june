# Local voice playback

Voice playback is an experimental, on-device Apple Silicon macOS feature. It
uses OmniVoice 0.2.0 to speak agent chat replies with either June's generated
default voice reference or a reference supplied by the user. Reply text,
reference audio, and synthesized audio remain local. The feature does not call
June API and does not consume OS Accounts credits.

## Availability and licensing

OmniVoice source is Apache-2.0. Its published weights are CC-BY-NC, and its
audio tokenizer has separate terms. An on-demand download and June's
acknowledgement screen do not grant commercial rights. Official release builds
therefore keep the feature disabled unless the build explicitly sets:

```sh
OS_JUNE_ENABLE_LOCAL_VOICE_PLAYBACK=1 pnpm tauri:build -- --bundles app
```

Use that flag for official production distribution only after legal approval
and compatible commercial terms cover the weights and transitive model
components. Debug and local experimental builds support personal evaluation.
The pinned model source and license are recorded in
[ADR 0016](adr/0016-local-voice-playback-python-sidecar.md#attribution-and-license-boundary).

The included audio tokenizer requires this attribution: Built with Higgs
Materials licensed from Boson AI USA, Inc., Copyright Boson AI USA, Inc., All
Rights Reserved, and Meta Llama 3 licensed under the Meta Llama 3 Community
License, Copyright Meta Platforms, Inc., All Rights Reserved. Review the full
[audio tokenizer terms](https://huggingface.co/k2-fsa/OmniVoice/blob/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/audio_tokenizer/LICENSE)
before enabling a release build.

Only clone a voice you own or have explicit permission to use. Do not use voice
playback for impersonation, deception, harassment, or to misrepresent a
speaker's consent.

## Setup

Open Settings > Audio > Voice playback and start setup. June:

1. Provisions Python 3.12 with `uv`.
2. Resumes the pinned OmniVoice download when partial cache data exists.
3. Verifies the required-file manifest for revision
   `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`.
4. Starts the worker with MPS float32/eager inference and the audio tokenizer on
   CPU.
5. Generates the stable default reference, caches its voice-clone prompt, and
   synthesizes a real validation sample.
6. Verifies the sample before marking setup ready.

Settings shows download, verification, model-load, and synthesis progress. An
interrupted download or setup can be retried without discarding a valid partial
cache.

## Playback modes

- **Click to play** is the default. Use the speaker action below an assistant
  message to play or stop that reply.
- **Play while streaming** queues each completed sentence while the assistant
  reply is still arriving.

June speaks visible prose only. Hidden reasoning, tool calls and results,
protocol events, fenced code blocks, image references, link targets, and
Markdown structure are omitted. Inline-code markers are removed while their
readable text is retained. Playback stops immediately when recording or
dictation starts, the agent chat session changes, or the user presses stop.

## Custom reference

Choose a clear WAV with one speaker and little background noise, then provide
the exact transcript. The transcript is required. June validates the audio and
format before copying the clip into app-owned storage. OmniVoice recommends
3-10 seconds for best results, but June accepts any duration so the user owns
the quality and performance tradeoff. The worker derives and caches a
voice-clone prompt from the copied clip; changing the clip or transcript
invalidates that prompt.

## Storage

Python, packages, the verified model revision, partial download state, the
generated default reference, custom reference, and cached prompt live under
June's app data directory in `voice-playback/`. They survive app updates so the
multi-gigabyte setup is not repeated. User-selected source WAVs are never
modified or deleted.

## Troubleshooting

- **Setup cannot find `uv`**: install `uv`, quit June, reopen it, and retry.
  June checks the GUI process path and the standard Apple Silicon install
  locations.
- **Download stops**: retry setup. A valid partial cache should resume.
- **Manifest verification fails**: retry setup. June rechecks every pinned file
  and downloads any invalid file again.
- **Preview is silent**: confirm system output and volume, then try the preview
  again. Preview playback uses macOS `afplay`.
- **The worker exits or playback overlaps recording**: treat this as a defect.
  Hard cancellation should stop both `afplay` and the worker before recording,
  dictation, or another agent chat session proceeds.

## Validation

Before release or local handoff, verify on an Apple Silicon Mac:

1. A clean setup shows resumable download and verification progress and ends
   with an audible sample.
2. A restart reuses the verified cache and generated default reference.
3. Click playback starts and stops from one assistant message.
4. Streaming mode begins after a complete sentence and preserves sentence
   order.
5. Hidden reasoning, tool and protocol content, code, and Markdown are not
   spoken.
6. A valid audible WAV plus exact transcript changes the voice; invalid
   files remain outside app storage.
7. Recording, dictation, an agent chat session change, and explicit stop each
   terminate native playback and the worker without stale audio.
8. Network inspection shows no reply or reference data sent to June API.
