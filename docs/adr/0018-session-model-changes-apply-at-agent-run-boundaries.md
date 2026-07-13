# ADR 0018: Session model changes apply at agent run boundaries

Date: 2026-07-13
Status: accepted

## Context

June previously treated an existing Hermes session's model as immutable. The
composer rendered it as passive status and asked the user to start another
session to choose a different model. That restriction is unnecessary, but
removing it exposes a runtime boundary: Hermes rejects `config.set` with 4009
while a session is running because replacing the model client during inference
would race the active response and its tool loop.

A model choice can also cross several identities and providers. The frontend
uses June's stored session id, `config.set` needs the live runtime session id,
and the loopback provider must distinguish an explicitly remote model from a
configured local model with the same raw id. AgentWorkspace and Note Chat can
both remain mounted for one stored session, so their writes can race even when
each surface is internally ordered.

## Decision

Model selection is staged and applied at the next **agent run** boundary:

- The model picker remains available while a response is running. Choosing a
  model only records the desired session-local selection; it never cancels,
  restarts, or reroutes the active agent run.
- Send synchronously snapshots the selected model before any skill expansion,
  attachment import, title generation, consent, session creation, or other
  awaited work. A later picker choice belongs to a later Send.
- For an existing session, June waits until Hermes is truly idle, applies the
  captured choice with session-scoped `config.set`, then submits the prompt.
  The model mutation through accepted `prompt.submit` is serialized by stored
  session id across AgentWorkspace and Note Chat.
- An agent run includes its tool loop and automatic goal continuations. Those
  continuations keep the model with which the user-initiated run started. A
  steer consumed by that run does too; if an undrained steer becomes an
  ordinary follow-up, that new prompt uses the model captured with the steer.
- Session choices and monotonic applied revisions are retained locally so an
  acknowledgement for an older Send cannot clear a newer picker choice.
- June stores reserved internal Hermes model ids for Auto, explicit remote, and
  local routes. The desktop loopback proxy decodes those ids before forwarding
  inference, so provider provenance survives raw-id collisions and no reserved
  id reaches June API or a local model endpoint. An unavailable selected local
  route fails closed instead of silently moving the conversation off-device.
- With no session open, the picker continues to update the app-wide generation
  default. The optimistic UI choice is the source for an immediate Send while
  settings persistence completes in serialized order.

## Consequences

- Changing the picker during a response is immediate in the UI but deliberately
  has no effect on that response. The next prompt is blocked if its captured
  model cannot be applied; June never silently falls back to the previous one.
- A `message.complete` frame is not proof that Hermes is idle. Post-turn work or
  an automatic goal continuation can keep returning 4009, so the next Send
  retries only that busy error and keeps the captured prompt recoverable.
- Every path that can become a prompt (ordinary Send, attachment queue, steer
  fallback, Note Chat, and media-session follow-up) must carry the Send-time
  model snapshot. New prompt surfaces must join the same session dispatch lock.
- The reserved model-id prefixes are an internal desktop-to-Hermes loopback
  contract. Hermes pin upgrades must keep the model-list aliases, `config.set`
  behavior, and proxy decoding in the compatibility and smoke gates.
- The June API wire contract does not change and no backend deployment is
  required.

## Alternatives considered

- **Keep existing sessions model-locked.** Rejected: it prevents the requested
  workflow even though Hermes supports an idle, session-scoped mutation.
- **Apply the picker change immediately.** Rejected: Hermes correctly refuses
  it while running, and forcing it would make one tool-loop run use inconsistent
  clients or providers.
- **Interrupt and restart the response on the new model.** Rejected: a picker
  action must not discard work or duplicate side effects.
- **Use the app-wide provider setting at inference time.** Rejected: a later
  settings change could reroute an active tool continuation, and colliding local
  and remote ids would be ambiguous.
- **Queue only a model id, then read the latest choice after asynchronous Send
  preparation.** Rejected: a picker change after Send would retroactively alter
  the message the user already submitted.

