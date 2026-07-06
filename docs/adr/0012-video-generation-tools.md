# Video generation (fast path + LLM tools, async + quote-priced)

## Status

proposed - JUN-202. Clones the image-generation stack (ADR 0008, PR #584) for
video, adapted for Venice's **asynchronous, dynamically priced** video API. The
image invariants are inherited wholesale; this ADR records only where video
*departs* from image and why.

## Context

JUN-202 asks for "video generation using the image generation pattern." Image
generation (ADR 0008) is a synchronous, flat-priced flow: one request does
`authorize hold -> Venice generate -> charge`, priced by a static per-model
credit map. A live probe of the Venice API (the blocking Step 0 from the JUN-202
handoff; the image-gen equivalent burned hours by assuming Venice extras that did
not exist) shows video is neither synchronous nor flat-priced.

### Step 0 findings - the live Venice video API (`https://api.venice.ai/api/v1`)

The catalog (`GET /models?type=video`) lists 111 video models across families
(Seedance, WAN, LTX, Kling, Veo, Sora, Pixverse, Runway, ...), each with a
`model_spec.constraints` block that is the authoritative source of valid
`duration` / `resolution` / `aspect_ratio` / `audio` combinations and the
`model_type` (`text-to-video`, `image-to-video`, `reference-to-video`,
`video-to-video`). This matches ADR 0007: capabilities and constraints come from
the live catalog, never from `traits`.

Generation is an **async job lifecycle**, not a single call:

- `POST /video/queue` `{model, prompt, duration, resolution?, aspect_ratio?, audio?, negative_prompt?, image_url?, ...}` -> `{model, queue_id, download_url?}`. `download_url` is present only for VPS-backed models (a 24h pre-signed mp4 URL); otherwise the bytes come from retrieve.
- `POST /video/retrieve` `{model, queue_id, delete_media_on_completion?}` -> either JSON `{status: PROCESSING|COMPLETED, average_execution_time, execution_duration}` (P80 example ~145000 ms) or, when COMPLETED and not VPS-backed, the raw `video/mp4` bytes. 404 if the job expired/was deleted.
- `POST /video/complete` `{model, queue_id}` -> `{success}`; deletes the video from Venice storage after a successful download.
- `POST /video/quote` `{model, duration, resolution?, aspect_ratio?, audio?}` -> `{quote}` (USD). Free to call; this is the price oracle.

Pricing is **dynamic**: a quote is a function of model + duration + resolution +
aspect_ratio + audio. Observed live: `wan-2.2-a14b` 480p/5s = $0.06, 720p/5s =
$0.11; `seedance-2-0-fast` 480p/5s = $0.35, 720p/10s+audio = $1.51;
`ltx-2-fast` 1080p/6s+audio = $0.26; `kling-v3-standard` 720p/5s = $0.46. Spec
cap is $10/request. Per-model duration/resolution enums are enforced by the
quote/queue endpoints (e.g. `veo3-fast` accepts only 4s/6s/8s; `sora-2` only
4s/8s/12s; `wan-2.2` only 5s), so a flat per-model credit price (as image uses)
would mis-price by up to ~25x across a single model's own valid range.

Content-policy and consent responses that the flow must handle: `422`
content-violation (on queue and on retrieve), `409 needs_consent` (Seedance
face-bearing media), `413` payload-too-large, `403` region, `503` at-capacity.

### Why the image assumptions break

1. **Flat price per model** (ADR 0008 / handoff invariant #1) is wrong for
   video: price varies with duration/resolution/audio. See Decision 1.
2. **Synchronous billing** (`authorize -> provider -> charge` in one request)
   does not fit a job that takes minutes and returns its result across multiple
   HTTP calls. See Decision 2.
3. **The ledger pins full outputs in memory** (image holds base64 in
   `GeneratedImage`). A single video is 100-1000x an image; the 32-entry cap
   would become gigabytes. See Decision 4 (handoff invariant #4).
4. **Video bytes must not be base64'd through JSON** end to end (handoff
   invariant #15); a 500 MB base64 body is a non-starter. See Decision 5.

## Decision

### 1. Quote-derived pricing with a config allowlist (not a flat map)

June charges credits derived from the **live Venice quote**, not a static
per-model price. Before authorizing or queueing, `VideoService`:

1. Validates the requested model is in a config **allowlist** (`video_pricing`
   in `june-config`: `model_id -> markup`, default markup mirrors image's ~2x).
   A model absent from the allowlist is rejected `model_not_priced` (422)
   **before the wallet or Venice is touched** - preserving handoff invariant #1
   ("unpriced model rejected before wallet or Venice"), just with an allowlist +
   markup instead of a flat credit figure.
2. Calls `POST /video/quote` to get the Venice USD price for the exact
   (model, duration, resolution, aspect_ratio, audio) tuple.
3. Converts to credits: `credits = ceil(quote_usd * markup * 1000)` (`$1 = 1000
   credits`, the image convention). This is the `estimate` authorized and, on
   success, the amount charged (clamped to the authorization cap).

A defensive **max-credit ceiling** per request (config, derived from Venice's
$10 cap x markup) rejects an implausible quote before authorize, so a catalog
change cannot authorize an unbounded hold.

### 2. Async is exposed to the client as job + poll; charge settles at completion

`POST /v1/video/generate` authorizes the hold, queues the Venice job, records
the job in the ledger, and returns `{job_id}` immediately (June's own job id,
never Venice's raw `queue_id`). The client polls `GET /v1/video/status/:job_id`,
which forwards a Venice retrieve: while `PROCESSING` it returns `{status:
processing, ...progress}`; on `COMPLETED` it retrieves the bytes, **charges**,
persists the mp4 to disk, and returns a handle. The charge happens on the
completing poll, inside a spawned, cancellation-safe settlement task (image
invariant carried over: a route timeout must not cancel between Venice success
and the charge).

The **hold TTL must cover the whole job lifetime** (queue -> completing poll),
not just one request (handoff invariant #6, "hold must cover the whole job
lifetime"). A new `authorize_hold_ttl_video_secs` is sized to the max video job
duration + settlement margin and pinned by a config invariant test, exactly as
the image hold TTL is. Timeout ordering (handoff invariants #7, #14) becomes:
Hermes tool timeout >= MCP timeout >= status-poll route timeout >= Venice
retrieve timeout; and the *job* budget (max polls x interval) is what the hold
must cover, not any single request.

### 3. Per-process residual risk is accepted and documented (as image does)

The request ledger stays in-process (handoff invariant #9). At video prices the
exposure is larger than image's flat 20-80 credits, and a June API restart
mid-job additionally **orphans the Venice job** (the poll loop dies; the hold
expires; the user is not charged; Venice may still bill June for the queued
job). This is accepted for the first cut and documented here and at the ledger,
tied to durable-request-state follow-up #613. As with image, the fix is NOT to
derive the settlement key from the client request id (that reopens the round-3
replay-funded-free-work hole); it is durable job state, deferred to #613.

### 4. The ledger stores a video handle, not bytes

`VideoGenerateOutput` / the ledger's `Complete` entry hold a **file path/handle**
to the persisted mp4 (plus metadata: model, mime, size, poster), never the video
bytes. The replay/pending caps and TTLs are inherited from image; because
entries no longer pin large payloads, the caps bound handle count, not gigabytes
(handoff invariant #4).

### 5. Video bytes move by file handoff, never base64-through-JSON

The desktop loopback proxy streams the mp4 to a Hermes media dir and hands the
MCP/tool a `MEDIA:` path; the frontend renders from that path via a bounded
full-size read (never the 5 MB image-preview cap, which every video exceeds -
handoff invariant #21). No `/v1/video/*` request or response carries the whole
video as a base64 JSON field (handoff invariant #15).

### 6. Two tools mirroring image, in a new `june_video` MCP server

- `generate_video(prompt, ...)` -> text-to-video (the `generate_image` analog).
- `animate_image(source_ref, prompt, ...)` -> image-to-video (the `edit_image`
  analog): takes an HMAC capability ref to a prior generated image, reusing the
  exact edit-source trust boundary (handoff invariant #13). This is the read of
  "full parity with image-gen": image-gen shipped generate + edit; video's edit
  analog is image-to-video. Venice's exotic inputs (reference-to-video,
  video-to-video, audio-input, elements/scenes) are **beyond** image-gen parity
  and are explicit follow-ups, not in this change.

A **new `june_video` MCP server** (not an extension of `june_image`): CONTEXT.md
lists MCP servers by concern (`june_context`, `june_web`, `june_image`), and the
async poll loop + video magic-byte set + video media cache are cleanly separable.
The security-critical work (magic-byte sniff, size caps, HMAC refs, token, body
caps) lives in the Rust loopback proxy as it does for image; the Python MCP is a
thin forwarder that additionally **polls** `GET /v1/video/status/:job_id` until
terminal, with the same one-request-id-per-tool-call, transport-only,
bounded-retry discipline (handoff invariant #12).

### 7. Fast path, rendering, model picker, feature flag - as image, adjusted for async

- `/video <prompt>` slash command behind `VIDEO_GENERATION_ENABLED` (default
  **off** for the first ship; kill-switch precedent `IMAGE_GENERATION_ENABLED`).
  No keyword-regex interception of follow-ups (handoff invariant #18); the model
  drives iteration through tools.
- A new `AgentChatVideoPart` sibling of `AgentChatImagePart` with a `<video>`
  player; `MEDIA_VIDEO_REFERENCE_PATTERN` extends MEDIA-ref rendering with video
  extensions; the round-2 guard (user-authored text mentioning MEDIA paths stays
  text) is preserved (handoff invariant #20).
- The running state is **long** (minutes) and shows poll progress, unlike the
  near-instant image loader.
- A curated `VIDEO_MODELS` list with descriptions from day one (no "Model
  details unavailable"); a `ModelMode::Video` across the Rust/TS settings
  surfaces (the existing `providers/mod.rs` test that asserts `"video"` is an
  invalid `ModelMode` is updated).
- Lazy-attach of a fast-path result into model context is **image-only**: vision
  models cannot read video, so a generated video is not attached as model-visible
  bytes; it renders in-thread and the model iterates via the tool.

### 8. Domain language and back-compat

- CONTEXT.md gains **video generation** and **image-to-video** terms in the same
  change (handoff invariant #22), following the "image editing" precedent; no
  "txt2vid/img2vid" jargon in prose (binding _Avoid_ lists).
- `/v1/*` stays backward compatible: `/v1/video/generate` and
  `/v1/video/status/:job_id` are **new** endpoints; no existing endpoint, field,
  or shape changes (handoff invariant #25). June presents as June, never Hermes
  (#24).
- Needs a June API deploy to work end to end (new endpoints).

## Consequences

Built and reviewed as sequenced, independently verifiable chunks on one branch /
one PR:

1. **Docs + decisions** (this ADR, CONTEXT.md terms).
2. **june-api money path** - domain types + `ActionSlug::VideoGenerate` (and the
   image-to-video slug), `venice_video.rs` provider (queue/retrieve/quote/
   complete), `VideoService` (async job ledger, quote-derived billing, handles
   not bytes), config (allowlist/markup, video hold TTL, invariant tests),
   `POST /v1/video/generate` + `GET /v1/video/status/:job_id` handlers, wiring,
   HTTP-boundary tests. The highest-risk chunk; the contract everything else
   builds against.
3. **Desktop bridge** - proxy routes + body caps + BYOK allowlist for
   `/v1/video/*`, video magic-byte sniffing + `video_cache` whitelist, HMAC
   source refs generalized for the animate path, `ModelMode::Video`, provider
   getters, tauri commands.
4. **`june_video` MCP** - `generate_video` / `animate_image` tools + the poll
   loop + `--self-test`, and its `hermes_bridge.rs` registration (sync, config
   render, SOUL tool instructions, token env, media dir, download whitelist).
5. **Frontend** - `/video` command + flag, `AgentChatVideoPart` + player + MEDIA
   video refs, curated `VIDEO_MODELS` + `ModelMode::Video`, async running/progress
   UI.

Trade-offs and risks:

- Two long-lived paths (fast + tool) must stay consistent in render, model
  selection, billing, and **polling/cancel** semantics.
- The quote adds a Venice round-trip before authorize; a quote failure fails the
  request before any hold (no charge).
- Accepted boundaries carried from image and re-stated for video prices: the
  per-process ledger (Decision 3, #613) and the round-3 "never key charges off
  the client request id" rule. Reviewers will re-find these; they are adjudicated
  here, not reopened.
- First-cut media retrieval is bounded buffering (100 MiB) in June API and the
  desktop so oversized videos fail before charge or disk write. Follow-up:
  switch raw mp4 delivery to incremental streaming to disk/HTTP (for example
  axum `StreamBody` plus reqwest streaming) so even accepted videos are never
  fully buffered in memory.
- Desktop downloads of provider-supplied video URLs validate `https` and reject
  hosts that are IP literals or resolve to non-public addresses before fetching,
  then pin the download client to those pre-validated addresses via
  `resolve_to_addrs` with redirects disabled (`redirect::none`), so it never
  re-resolves DNS at connect time or follows a redirect to an unvalidated host.
  This closes the DNS-rebinding TOCTOU (resolve once, then re-resolve) that a
  single-resolution path would leave open.

Reference: Venice video API - `https://api.venice.ai/api/v1/swagger.yaml`
(paths `/video/queue`, `/video/retrieve`, `/video/quote`, `/video/complete`).

## Addendum (2026-07-06): Seedance delisted, default moved to wan-2.2-a14b

Venice removed the entire Seedance line from its live catalog after the Step 0
findings above were captured. The symptom was subtle: `/video/quote` prices
leniently and still accepted `seedance-2-0-fast-text-to-video` (placing a credit
hold), while `/video/queue` validates the model against the live catalog and
rejected it with a `400`. The provider logged only `body_bytes`, hiding Venice's
"unknown model" reason.

Changes: default text-to-video model moved to `wan-2.2-a14b-text-to-video` (the
other curated model, confirmed live and constrained to 5s / 720p-580p-480p /
16:9-9:16-1:1, audio unsupported — a match for the fixed 5s/720p default);
`seedance-2-0-fast-text-to-video` dropped from `DEFAULT_VIDEO_MODEL` (frontend +
desktop), the `VIDEO_MODELS` picker list, and the `video_pricing` allowlist; and
the video provider now logs a bounded upstream error-body snippet so the next
catalog drift is self-diagnosing. This is a concrete instance of the already
flagged "per-model options from live catalog" follow-up: a hardcoded model list
drifts against a moving upstream, and the durable fix is to source the allowlist
and per-model duration/resolution constraints from Venice's `/models` at
build/deploy time rather than pinning IDs by hand.
