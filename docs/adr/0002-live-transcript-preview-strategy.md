# Live transcript preview for meeting notes

## Status

accepted - Phase 1 microphone preview implemented

## Context

Users want to see words appear while June is taking meeting notes. The product
question is whether we should build that as true real-time transcription or as a
lower-risk live preview that later reconciles with June's existing saved-audio
pipeline.

The current meeting-notes architecture is deliberately saved-audio-first:

- `src-tauri/src/audio/capture.rs` records microphone audio to local WAV files
  and tracks live levels.
- `src-tauri/src/audio/system_macos.rs` records system audio as a separate local
  source on supported macOS versions.
- `finish_recording` validates finalized source artifacts before starting
  transcription.
- `src-tauri/src/domain/processing.rs` detects microphone and system turns after
  recording, transcribes saved turn WAVs, persists source transcripts, and only
  then generates notes.
- `src/components/note-editor/NoteEditor.tsx` already has a Transcription tab
  that renders ordered `Microphone` and `System` turns.

That reliability model matters. Saved audio is the retry source of truth, and
the transcript that feeds note generation is built from validated audio rather
than volatile UI text.

Provider capabilities are uneven:

- OpenAI supports realtime transcription sessions for live transcript deltas
  from streaming audio. Its file-oriented speech-to-text guide explicitly points
  microphone, call, and media-stream use cases to realtime transcription.
- Google Cloud Speech-to-Text, Amazon Transcribe, and Azure Speech all document
  cloud streaming speech-to-text paths.
- Local Whisper-style systems can run a chunked or sliding-window preview, but
  classic Whisper is not a native streaming ASR model. Implementations such as
  `whisper.cpp` describe their stream example as sampling audio periodically and
  running inference repeatedly. That can be useful, but latency, repetition,
  battery use, and correction behavior are product constraints.

So the decision is not "OpenAI or nothing." The decision is to separate the
user-visible live transcript surface from the provider transport that produces
preview text.

## Decision

Build **live transcript preview** as an optional recording companion, not as the
source of truth for notes.

The initial contract should be provider-neutral:

```ts
type LiveTranscriptSource = "microphone" | "system";
type LiveTranscriptTransport = "chunked" | "streaming";
type LiveTranscriptStability = "partial" | "final";

type LiveTranscriptEvent = {
  noteId: string;
  sessionId: string;
  sourceMode: "microphoneOnly" | "microphonePlusSystem";
  source: LiveTranscriptSource;
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string;
  stability: LiveTranscriptStability;
};
```

Phase 1 ships the microphone chunked-preview subset of this contract through
the `live-transcript-event` Tauri event. The system-audio lane remains part of
the provider-neutral design, but live system-source preview requires extending
the macOS helper process to expose preview PCM without weakening the finalized
audio source-of-truth path.

The event stream is ephemeral UI state:

- It appears while a note is actively recording.
- It may revise, replace, or drop partial text.
- It is not copied into `transcripts` as the final record.
- It is reconciled or discarded when final post-recording processing completes.
- If preview fails, recording continues and the final transcript still runs from
  saved local audio.

Product copy should avoid promising exact realtime behavior. Use "Live preview"
or "Live transcript preview" in the app unless we are specifically describing a
provider-backed streaming implementation.

## Architecture

### Backend capture tap

Add a non-blocking live-preview tap beside the existing file writer:

1. The capture callback still prioritizes writing source audio to disk and
   updating level stats.
2. A bounded channel receives small PCM windows for preview.
3. If the preview channel is full, drop preview audio and keep recording.
4. Pause and resume follow the recorder state.
5. Microphone and system audio stay in separate lanes.

This should not hold the current `ACTIVE_RECORDING` mutex during provider work.
Provider work belongs in a worker task that consumes preview chunks and emits
Tauri events.

### Frontend state

The frontend should store live preview turns separately from `NoteDto`:

- Key by `sessionId`, `source`, and `segmentId`.
- Sort by `sequence`, then `startMs`.
- Render partial text with a lighter treatment than final preview segments.
- Clear the preview when the recording session ends and the persisted transcript
  arrives.
- If a new recording starts while another note is transcribing, show the normal
  recording UI and the new session's preview, not the previous session's
  pending processing state.

The Transcription tab can reuse the existing source-turn layout, but it should
make preview status clear:

- While recording: show "Live preview" as quiet metadata.
- After stop: show the existing transcribing or generating state until final
  persisted turns are available.
- If preview is delayed or unavailable: show a small status line and keep the
  recorder controls usable.

### Provider abstraction

Introduce a capability boundary rather than a provider-specific UI path:

```rust
enum LiveTranscriptCapability {
    Unsupported,
    ChunkedPreview,
    StreamingDeltas,
}

trait LiveTranscriptProvider {
    fn capability(&self) -> LiveTranscriptCapability;
    async fn run(&self, input: LiveTranscriptInput, sink: LiveTranscriptSink)
        -> Result<(), AppError>;
}
```

The project toolchain already satisfies the Rust 1.75+ requirement for direct
`async fn` in traits (`scribe-api` pins Rust 1.95). If this boundary needs to be
used as an object-safe trait, implement it with `async_trait` or an explicit
boxed future instead of relying on direct `async fn` trait object dispatch.

Provider implementations can differ internally:

- `ChunkedPreview` can use short rolling WAV windows and the existing Scribe API
  transcription path. It is less immediate, but it keeps the private,
  saved-audio-first posture and avoids a proprietary realtime dependency.
- `StreamingDeltas` can use OpenAI, Google, AWS, Azure, or another provider with
  a true streaming API. It should normalize provider-specific partial and final
  events into `LiveTranscriptEvent`.
- `Unsupported` disables the preview while preserving recording and final
  transcription.

## Phased rollout

### Phase 1: Chunked local/private preview

Ship an experiment that provides useful live visibility without changing the
final transcript contract.

- Capture 5-10 second rolling windows per source.
- Send windows to Scribe API using a new preview action or a constrained variant
  of the current transcription endpoint.
- Prompt each chunk with recent preview text to reduce repeated words.
- Emit provisional `LiveTranscriptEvent` records to the frontend.
- Drop stale chunks if transcription falls behind.
- Do not bill users for both preview and final transcription without an explicit
  product decision. The billing model must be resolved before broad rollout.

Implemented Phase 1 behavior:

- The microphone capture callback feeds a bounded preview channel while the WAV
  writer remains the priority.
- Preview workers transcribe 8 second microphone chunks as `preview=true`
  Scribe API requests.
- The API validates the model and audio but returns a zero-credit receipt for
  preview requests. It does not authorize a hold or settle a wallet charge.
- React stores preview events outside `NoteDto`, renders them only in the
  Transcription tab, and clears them when recording stops.

Expected behavior: users see delayed live preview, usually a few seconds behind.
This is not word-by-word realtime, but it answers "is June hearing this meeting"
and gives users confidence during the recording.

### Phase 2: Optional streaming providers

Add a provider capability for true streaming deltas.

- Gate cloud streaming behind explicit provider selection and privacy copy.
- Keep raw audio inside the current Scribe API trust boundary when possible.
- Prefer server-side WebSocket or gRPC bridges so provider keys stay out of the
  desktop app.
- Normalize every provider into the same frontend event shape.
- Keep final persisted transcripts generated from saved local artifacts unless
  we intentionally add an audited path for accepting streaming finals.

Expected behavior: users who opt into a streaming-capable provider get lower
latency. Users who stay on the private default still get chunked preview or no
preview, depending on model support.

### Phase 3: Local streaming ASR runtime

Evaluate a dedicated local ASR runtime only after Phase 1 teaches us the product
latency threshold.

- Candidate engines must handle macOS and Windows packaging.
- CPU, memory, battery, model download size, and update flow must be measured.
- The local engine must support cancellation and backpressure.
- A local model can power preview even if final transcript generation continues
  through the existing provider path.

Expected behavior: privacy-friendly live preview without sending raw audio to a
new cloud provider, if runtime costs are acceptable.

## Privacy and product guardrails

- Do not silently route live audio to a new third-party provider.
- Default to the current private path unless the user deliberately chooses a
  streaming provider.
- Make preview status honest. "Live preview delayed" is better than pretending
  partial text is authoritative.
- Never let preview failure fail the recording.
- Never let preview backpressure block the file writer.
- Keep consent reminders and recording indicators unchanged.
- Preserve saved local audio as the retry source of truth.

## Acceptance criteria for the first implementation PR

- Recording and final note generation still work when live preview is disabled.
- Preview failures do not change recorder state or processing status.
- Partial preview text is visually distinct from persisted transcript text.
- Stopping a recording clears preview state and transitions to the existing
  transcribing or generating states.
- A queued second recording shows its own live preview while the prior recording
  continues background processing.
- Microphone-only and microphone-plus-system modes both have deterministic
  source lanes.
- Tests cover frontend preview reconciliation and backend preview backpressure.
- Phase 1 preview calls do not result in a separate user charge without a
  product decision on billing.

## Open questions

- What latency threshold feels valuable enough for Phase 1: 3 seconds, 5
  seconds, or 10 seconds?
- Do users expect preview to appear in the Notes tab, the Transcription tab, or
  both?
- Should preview be included in copied transcript text while recording?
- How should preview usage be priced if it calls paid transcription models
  before final transcription?
- Does the product want a "use cloud realtime transcription" setting, or should
  it be attached to model selection?

## References checked on 2026-06-16

- [OpenAI Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [OpenAI Realtime and audio guide](https://developers.openai.com/api/docs/guides/realtime)
- [OpenAI Speech to text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Google Cloud Speech-to-Text streaming audio guide](https://docs.cloud.google.com/speech-to-text/docs/v1/transcribe-streaming-audio)
- [Amazon Transcribe streaming audio guide](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html)
- [Azure Speech-to-text documentation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/index-speech-to-text)
- [whisper.cpp realtime audio input example](https://github.com/ggml-org/whisper.cpp?tab=readme-ov-file#real-time-audio-input-example)
