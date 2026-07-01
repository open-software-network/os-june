# Image generation and editing (fast path + LLM tools)

## Status

proposed - grill-with-docs design for JUN-129 follow-on; implementation phased
(Phase A first).

Landed ahead of the phases: **image generation is now metered** (this PR). It
runs through a `june_services::ImageService` (authorize hold -> generate ->
charge, mirroring the web tools), priced per model by a dedicated `image_pricing`
map in `june-config` kept separate from the text/ASR catalog so image models
never leak into the served pickers. An unpriced model is rejected
`model_not_priced` (422); an out-of-credits user gets 402 before Venice is
called. Prices (Venice per-image cost x ~2, `$1 = 1000 credits`):
`venice-sd35` 20, `flux-dev` 20, `qwen-image` 60, `hidream` 40. **Editing**
metering ships with the `/image/edit` endpoint in Phase C.

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
- **Venice supports editing** via `POST /api/v1/image/edit` (img2img/inpaint):
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

4. **img2img via a new June API endpoint.** `POST /v1/image/edit` backed by a new
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
- **Phase C - `edit_image` + img2img backend (large).** New `/v1/image/edit`
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
