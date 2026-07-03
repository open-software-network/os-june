# Image generation and editing (fast path + LLM tools)

## Status

accepted - all three phases (A, B, C) implemented under JUN-171.

Landed ahead of the phases: **image generation is now metered** (this PR). It
runs through a `june_services::ImageService` (authorize hold -> generate ->
charge, mirroring the web tools), priced per model by a dedicated `image_pricing`
map in `june-config` kept separate from the text/ASR catalog so image models
never leak into the served pickers. An unpriced model is rejected
`model_not_priced` (422); an out-of-credits user gets 402 before Venice is
called. Prices (Venice per-image cost x ~2, `$1 = 1000 credits`):
`venice-sd35` 20, `flux-dev` 20, `qwen-image` 60, `hidream` 40. **Editing**
metering ships with the `/image/edit` endpoint in Phase C.

Implemented since (JUN-171):

- **Phase A** — the `/image` fast-path image is held per session and lazily
  attached to the user's next message via the existing `image.attach_bytes`
  path, so a follow-up reaches the model with the image in context.
- **Phase B** — a `june_image` MCP server (`generate_image`) POSTs through the
  loopback proxy to `/v1/image/generate` (the proxy injects the selected image
  model + safe-mode setting); tool-result image content renders inline by
  reusing `AgentChatImagePart`.
- **Phase C** — `edit_image` is backed by a new `POST /v1/image/edit`
  endpoint + `VeniceImageEditor` provider (base64 in, **raw-binary** response
  re-encoded to base64) + `ImageEditRequest` domain type, metered on
  `ActionSlug::ImageEdit` with its own `image_edit_pricing` map
  (`firered-image-edit` 80) and default edit model. The MCP writes generated /
  edited images to a dedicated images dir so a returned `filename` can be
  threaded back into `edit_image`.
- **safe_mode** — Venice safe mode is a Settings toggle, **default off**
  (privacy-first). It flows end to end as `Option<bool>` (absent = Venice
  default), so older app builds calling the endpoints are unaffected.

## Addendum - 2026-07-03

Phase C has landed. The current built-in fallback image generation price list is
`venice-sd35` 20, `flux-2-pro` 60, `qwen-image` 60, and `chroma` 20 credits per
image. Image editing is metered separately through `image_edit_pricing`, with
`firered-image-edit` priced at 80 credits per image edit.

## Context

JUN-129 shipped `/image <prompt>` as a client-side slash command: it creates a
session and renders the generated image in-thread (loader -> image -> view /
download) without calling the LLM. The image lives only in a client-side overlay
and is imported to the session workspace, but it never enters the session
*history the model reads*. So a follow-up like "do you think it's nice?" reaches
the model with an empty context, and the model cannot generate or edit images on
its own from natural language.

Desired behavior:

1. Explicit `/image` on a new session stays a fast, no-LLM shot.
2. A follow-up that references the image must find it in the model's context.
3. Natural-language requests ("draw me a cat", "make it fluffier") should drive
   image generation/editing as a first-class LLM tool, so it is conversational
   and iterable.

Architecture facts established while designing:

- **Hermes is an external Python agent runtime.** June exposes tools to the LLM
  via stdlib-only Python **MCP servers embedded in `src-tauri`**
  (`src-tauri/src/hermes/june_web_mcp.py`, `june_context_mcp.py`), synced to disk
  and registered with Hermes. Each is a thin stdio JSON-RPC server that POSTs to
  the June app's loopback provider proxy, which forwards to **June API**. Adding
  an image tool follows this exact pattern with **no external Hermes changes**.
- MCP `tools/call` results can carry image content natively, so a tool-produced
  image is a session message the model reads — context and iteration for free.
- **June API** already has `POST /v1/image/generate` (text-to-image; base64 in an
  `images[]` response; authenticated, **not metered** yet).
- **Venice supports editing** via `POST /api/v1/image/edit` (image edit/inpaint):
  input `image` as base64/URL + `prompt`, a **separate** set of edit models
  (default `firered-image-edit`), and a **raw binary** response (not the base64
  envelope `/image/generate` returns). So editing needs a *new* June API provider
  path, not a tweak to the existing generator.
- The model cannot pass image bytes as a tool argument (it only *sees* an image
  via vision). An edit therefore must reference the image by a stable **filename**
  the generate tool returned; the MCP tool reads those bytes from the session
  workspace.

## Decision

1. **Hybrid, not either/or.** Keep the `/image` fast path (no LLM) *and* add LLM
   image tools. The fast path stays instant for the explicit first shot; the tool
   path handles model-driven generation and iteration.

2. **Fast-path image enters context by lazy attach.** After a fast-path
   generation the image is held (silently — no composer chip, since it already
   renders in-thread) and attached to the user's *next* message via the existing
   `image.attach_bytes` + `prompt.submit` path. It enters history exactly when the
   model first needs it and then persists. This avoids relying on unverified
   "attach with no following prompt" runtime semantics.

3. **Two MCP tools** in a new `june_image` MCP server:
   - `generate_image(prompt)` -> renders + returns `{ image, filename }`.
   - `edit_image(source_filename, instruction)` -> reads `source_filename` from the
     workspace, edits it, returns `{ image, filename }`.
   Distinct schemas make the model's choice explicit (no source = generate; a
   required `source` = edit) and force the model to name a real prior image.

4. **Image edit via a new June API endpoint.** `POST /v1/image/edit` backed by a new
   `VeniceImageEditor` provider (base64 input, binary response) and an
   `ImageEditRequest` domain type, with its own default edit model. Edit models
   are a separate catalog from generation models.

5. **Tool-produced images render in-thread by reusing `AgentChatImagePart`** (the
   part added for the fast path), extended to cover tool-result images.

## Consequences

Phased so each phase ships value on its own:

- **Phase A - fast-path context (small, no backend).** Lazy-attach the fast-path
  image to the next user message. Directly fixes the "empty context" follow-up
  gap and unblocks tool-driven iteration on a `/image` shot.
- **Phase B - `generate_image` tool (medium).** New `june_image_mcp.py` +
  registration in `hermes_bridge.rs` (script const, sync, config render, system
  prompt line), backed by the existing `/v1/image/generate`. Render tool-result
  images inline.
- **Phase C - `edit_image` + image edit backend (large).** New `/v1/image/edit`
  endpoint + `VeniceImageEditor` provider + `ImageEditRequest` domain type +
  edit-model default/setting + the `edit_image` tool.

Trade-offs and risks:

- Two generation paths (fast + tool) must stay consistent in render, model
  selection, and billing. **Generation is metered** as of this PR (see Status);
  the tool path (Phase B) reuses the same `/v1/image/generate` and so is metered
  for free. **Editing** (Phase C) meters when its `/v1/image/edit` endpoint lands
  — edit models are a separate price catalog.
- The model must correctly thread a returned `filename` back into `edit_image`;
  the tool descriptions must make this contract explicit.
- **Non-vision chat models** can't "see" an attached image; the existing
  `unsupportedImageInputPrompt` path-in-prompt fallback applies, so iteration is
  degraded (prompt-only) on those models.
- Edit models (`firered-image-edit`, `nano-banana-*-edit`, `gpt-image-*-edit`, …)
  are a separate catalog needing their own default and, eventually, a settings
  picker alongside the existing Image generation model.

Reference: Venice image edit API - https://docs.venice.ai/api-reference/endpoint/image/edit

## Addendum - 2026-07-03 (post-review hardening: billing retries and edit-source capabilities)

PR #584 shipped phases A-C and then went through 12 adversarial review rounds.
Three design decisions came out of them that this ADR did not anticipate;
recorded here because each is load-bearing and none is obvious from the code
alone.

**1. Charge keys are unique per attempt; retry dedupe is a separate ledger.**
Every settled generation/edit charges under a fresh UUID v7 operation id.
Charge keys are deliberately NEVER derived from the client `requestId`: a
requestId-derived key lets a replayed id run fresh Venice work while OS
Accounts dedupes the settlement as a replay - free images (review round 3).
Retry safety comes instead from an in-process request ledger keyed
user + requestId + request shape: settled entries replay the stored output
without touching Venice or the wallet; concurrent duplicates coalesce; a
post-provider charge failure parks the output with a stable settlement key
(charge-pending) and a retry re-charges that same key rather than re-running
the provider. Entries expire (settled: 10 min / capped; pending: the hold TTL)
and eviction is per-user with waiter notification.

**Accepted boundary:** the ledger is per-process. A retry that crosses a June
API restart, an eviction, or an instance switch can re-run the provider and
settle a duplicate flat charge. Durable request state is issue #613; until
then this is a documented residual risk, bounded by the client's short retry
window and flat 20-80 credit prices. Do not "fix" it by reusing requestId as
the charge key - that reopens the round-3 bypass.

**2. Timeout ordering is a config invariant.** The image upstream client
timeout sits below the route timeout with a settlement margin, and the image
hold TTL sits above the request timeout (`request_timeout_secs` + 30);
`june-config` validation rejects violations. Post-provider settlement runs on
a spawned task so an outer route timeout cannot cancel between Venice success
and the charge. Clients (desktop command and MCP) mint ONE requestId per
logical turn, pin the request shape (model, safe mode) at turn creation, and
replay transport failures plus 429/503/504 with the identical payload.

**3. Edit sources are host-minted capability refs.** `edit_image` accepts only
opaque refs the Rust loopback proxy minted when returning a generated/edited
image: an HMAC over filename + content hash, keyed by a secret stored in app
data outside Hermes home (the Seatbelt profile denies runtime reads). The
Python MCP holds no secret and reads no source bytes. Consequence: the runtime
cannot mint or retarget refs (overwriting a stored file invalidates its ref),
and user-uploaded attachments are NOT tool-path edit sources - Hermes provides
no per-call session identity to MCP servers, so a conversation-scoped
allow-list is impossible on this transport. Restoring attachment editing needs
a session-identity mechanism first (recorded as a PR followup).
