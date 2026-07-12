# ADR 0016: Local voice playback via a managed Python sidecar

Date: 2026-07-11
Status: accepted

## Context

Voice playback reads agent chat replies aloud on demand or sentence-by-sentence
as a reply streams. The selected OmniVoice 0.2.0 text-to-speech (TTS) model
class performs zero-shot voice cloning but has no supported Rust-native or
ONNX runtime. Running it locally requires Python, PyTorch, its audio tokenizer,
and several gigabytes of model data.

Reply text can contain private note content. Sending it or a reference clip to
a hosted speech service would break June's private-by-architecture boundary and
would add an upstream call to a feature that should not be metered.

OmniVoice's source is Apache-2.0, while the published model weights are
CC-BY-NC. Downloading those weights after installation does not by itself grant
commercial-use or distribution rights. The bundled audio tokenizer also has
separate terms that must be reviewed. An acknowledgement in June cannot expand
any upstream license.

## Decision

Voice playback is a native Apple Silicon macOS feature backed by an
out-of-process Python sidecar. June owns its installation, model cache,
reference audio, lifecycle, and playback:

- `uv` provisions Python 3.12 and OmniVoice 0.2.0 under June's app data
  directory. Downloads are resumable and stored in an app-managed cache.
- The worker downloads the model from Hugging Face at revision
  `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`. A checked manifest verifies every
  required file before the installation can advance.
- Inference uses MPS with float32 and eager execution. The audio tokenizer stays
  on CPU. This avoids the corrupt output observed with the half-precision Apple
  Silicon path while retaining local acceleration for generation.
- Setup generates a stable default reference from its smoke phrase, caches its
  voice-clone prompt, synthesizes and verifies a real sample, and reports
  progress. Installation becomes ready only after that synthesis smoke
  succeeds.
- A custom reference is copied into app-owned storage only after June validates
  an audible WAV and its required transcript. OmniVoice's 3-10 second guidance
  is shown as a recommendation, not enforced. The worker caches the result of
  `create_voice_clone_prompt` so subsequent requests do not re-encode the clip.
- The sidecar synthesizes one sentence-sized request at a time. Native `afplay`
  owns playback, avoiding webview autoplay restrictions.
- Cancellation terminates playback and the worker process, clears obsolete
  queued work, and restarts a clean worker when needed. Recording, dictation,
  agent chat session changes, and an explicit stop all use this hard-cancel
  path.

Click-to-play is the default. Automatic playback begins only for completed
sentences in a streaming assistant reply. Text preparation omits hidden
reasoning, tool and protocol messages, fenced code blocks, links' targets,
images, and Markdown structure. Inline-code markers are removed while their
readable text is retained.

Official release builds keep voice playback disabled unless compiled with
`OS_JUNE_ENABLE_LOCAL_VOICE_PLAYBACK=1`. Debug and local experimental builds
may enable it for personal evaluation. Enabling production distribution or
commercial use requires legal approval and compatible commercial terms for the
weights and every transitive model component. The UI acknowledgement records
informed use; it is not a license grant.

## Alternatives considered

- **Hosted synthesis through June API**: rejected because reply text and
  reference audio must remain local, with no metering.
- **Rust-native inference**: rejected because OmniVoice has no supported
  Rust-native or ONNX path and a bespoke port would create a second model
  implementation to maintain.
- **Bundling Python, PyTorch, and model data**: rejected because of app and
  updater size, and because bundling would not solve the model license.
- **Soft cancellation**: rejected because completed stale synthesis can retain
  memory and speak after context has changed. Hard cancellation gives one
  lifecycle boundary for playback, recording, dictation, and session changes.

## Consequences

- The feature is restricted to native Apple Silicon macOS. Other platforms and
  browser previews remain unavailable.
- Initial setup downloads several gigabytes and synthesizes a verified smoke
  sample before activation.
  Settings must show real file and smoke progress rather than a binary spinner.
- The model and generated audio stay local. Voice playback makes no June API
  request and consumes no OS Accounts credits.
- Users must have permission to use the reference speaker's voice. June warns
  against impersonation, deception, harassment, or cloning a voice without the
  speaker's consent.
- The worker seam permits a future commercially licensed local model without
  changing the settings or chat behavior.

## Attribution and license boundary

- Source: [k2-fsa/OmniVoice](https://github.com/k2-fsa/OmniVoice) and its
  [Apache-2.0 license](https://github.com/k2-fsa/OmniVoice/blob/v0.2.0/LICENSE)
- Model: [k2-fsa/OmniVoice at the pinned revision](https://huggingface.co/k2-fsa/OmniVoice/tree/c5fdb5ccb189668d56333f77ba2629f4cd7535f4), CC-BY-NC
- Model license statement: [README at the pinned revision](https://huggingface.co/k2-fsa/OmniVoice/blob/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/README.md#license)
- Audio tokenizer terms: [audio_tokenizer/LICENSE at the pinned revision](https://huggingface.co/k2-fsa/OmniVoice/blob/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/audio_tokenizer/LICENSE)

See [Local voice playback](../voice-playback.md) for setup, storage, and
validation details.
