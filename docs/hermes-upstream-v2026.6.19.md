# Hermes upstream v2026.6.19

## Pin

- Previous June pin: `v2026.6.5`, commit `3c231eb3979ab9c57d5cd6d02f1d577a3b718b43`
- New June pin: `v2026.6.19`, commit `2bd1977d8fad185c9b4be47884f7e87f1add0ce3`
- Archive checksum: `7a9bd367066183898831c2760f269368ab54b458a1d1b51d14ef1f484dd490cc`
- Upstream changelog: `https://github.com/NousResearch/hermes-agent/compare/v2026.6.5...v2026.6.19`

## Compatibility checked

June still starts Hermes through:

```text
hermes dashboard --no-open --host 127.0.0.1 --port <port>
```

The upstream dashboard still exposes the API surfaces June consumes:

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{session_id}/messages`
- `DELETE /api/sessions/{session_id}`
- `GET /api/skills`
- `PUT /api/skills/toggle`
- `GET /api/messaging/platforms`
- `PUT /api/messaging/platforms/{platform_id}`
- `GET /api/cron/jobs`
- `POST /api/cron/jobs`
- `PUT /api/cron/jobs/{job_id}`
- `POST /api/cron/jobs/{job_id}/pause`
- `POST /api/cron/jobs/{job_id}/resume`
- `POST /api/cron/jobs/{job_id}/trigger`
- `DELETE /api/cron/jobs/{job_id}`
- `GET /api/tools/toolsets`
- `PUT /api/tools/toolsets/{name}`
- `WS /api/ws`

The upstream installer still leaves bare `$UV_CMD` invocations in a few install stages. June's post-extract patch remains required for app data paths containing spaces, such as `Application Support` on macOS.

## Features included in the runtime update

These capabilities are present in the bundled Hermes runtime after the pin bump. June does not necessarily expose each capability in first-party UI yet.

- Background subagents: `delegate_task(background=true)` can return a handle immediately and let work re-enter the conversation later.
- Image editing: `image_generate` supports image-to-image and editing flows in addition to text-to-image generation.
- Memory batch writes: the memory tool supports atomic operation batches through an `operations` array.
- Messaging expansion: upstream adds Photon Spectrum iMessage support, an official WhatsApp Business Cloud API adapter, richer Telegram Bot API 10.1 messages, and Raft agent network gateway support.
- Automation Blueprints: upstream adds guided, parameterized routine setup so users do not need to write cron syntax directly.
- Model and dashboard improvements: upstream adds dashboard profile builder flows, stronger dashboard auth, a composer model selector, xAI Grok Composer model support, Skills Hub browser updates, subagent watch windows, per-thread drafts, resizable terminal improvements, and desktop notification improvements.
- Reliability and security: upstream includes dashboard auth hardening, fail-closed policy fixes, secret redaction, environment sanitization for cron subprocesses, Windows ConPTY and PowerShell installer fixes, and dependency security bumps.
- Cost behavior: upstream changes curator defaults to reduce auxiliary model spend for routine background curation unless extra consolidation is explicitly enabled.

## Additional June integration work

No required app code migration was found for the existing June agent, skills, messaging settings, session list, or routines flows. The following upstream features need explicit June product integration before users can rely on them from June UI:

- Expose Photon iMessage only after adding setup UI for `hermes photon login`, device-code auth, and any account state or failure recovery copy.
- Expose Raft only after mapping `RAFT_PROFILE`, bridge lifecycle, and metadata-only wake events into June's session and notification model.
- Expose WhatsApp Cloud only after adding app-scoped credential fields and validating webhook or send-message setup paths.
- Expose Automation Blueprints by deciding how they fit with June's Routines editor instead of routing users to raw cron fields.
- Expose image editing by wiring existing file/image attachments into the upstream `image_generate` edit inputs.
- Expose background subagent watch handles by adding UI for pending work, completion events, and reopened sessions.
- Decide whether upstream dashboard profile builder and Skills Hub browsing should remain hidden behind June-native settings or become first-class June surfaces.
