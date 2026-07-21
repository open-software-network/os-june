# Home assistant experiment

Home is June's persistent, relationship-level conversation. It is distinct
from a focused **agent session**: Home holds the ongoing personal-assistant
thread, while agent sessions hold concrete work that can be opened, monitored,
and continued independently.

This document owns the experimental Home routing contract. The experiment is
intentionally local and reversible, so it does not introduce a new June API
contract or an ADR.

## Product contract

- Each Hermes profile has at most one stored Home session id on this device.
- Home starts on Auto (Lower) so ordinary conversation favors the fastest
  eligible private model. The composer keeps the existing model picker, and an
  explicit choice wins for that Home conversation at the next agent-run
  boundary under ADR 0018.
- Home never appears as a duplicate item in the Sessions list.
- A concrete task may become a focused agent session without navigating away
  from Home. The focused session uses the normal new-session model, reasoning,
  and Runtime mode defaults, starts in the background, and appears in the
  sidebar. Home's implicit speed-first route never leaks into task work.
- A task handoff is shown inline in Home. Selecting it opens the focused
  session with the normal agent-session UI.
- Home keeps lightweight suggestion nudges above the composer. They prefill the
  empty conversation and never run work without the user's Send.
- Sending locally echoes the user's bubble and June's typing bubble before the
  runtime finishes resuming or creating the persisted Home session.

## Home conversation paths

Ordinary text-only Home turns use the lightweight native `june_home_chat` path.
It sends a compact relationship prompt and one structured `start_task` tool,
which avoids loading the full Hermes agent prompt and tool catalog for a short
conversation. The selected Home model and reasoning effort are captured at the
Send boundary and passed through to this request. Auto Lower and Instant are
only the implicit defaults; an explicit composer choice wins.

Turns that need Hermes — attachments, slash commands, and other agent features
— are prefixed at runtime with a hidden `[June home context]` block. It tells
June that this is the persistent personal-assistant thread and that focused
work should be handed to the `june_home` MCP server rather than performed
inline. The block is not rendered in the transcript.

Both paths emit the same structured task request and render the same inline
handoff card. A process-wide queue keyed by the stored Home session id
serializes fast-path replies across Home navigation. The transcript is merged
from persisted stable turn ids so an older reply cannot overwrite newer turns.
If a fast-path call fails before a reply is committed, its optimistic user turn
is removed and the original text is restored as the persisted composer draft.

## `june_home` MCP server

| Tool | Input | Result | Meaning |
| --- | --- | --- | --- |
| `start_task` | `title` (string), `prompt` (string), optional `summary` (string) | The normalized task request | Ask the June desktop client to create and start a focused agent session. |

`start_task` is a signal, not a session store. The MCP server validates and
echoes the request. The Home client observes the completed tool call, creates
the Hermes session through the existing gateway, starts its first agent run,
and records the returned stored session id on the inline handoff card.

The model must call `start_task` only while the hidden Home context is present,
or while the compact Home system prompt is active, only for requests that
benefit from focused work or background execution, and at most once per
distinct task. Conversation, quick answers, clarifying questions, and
preference updates stay in Home.

## Amendments

- The initial experiment routed every Home message through Hermes and the
  `june_home` MCP server. Latency testing showed that the full agent prefill was
  a poor default for ordinary conversation, so text-only turns now use the
  equivalent lightweight structured-tool path described above.
- The initial handoff draft inherited the model shown in Home. Focused work now
  deliberately returns to normal new-session defaults so Auto Lower and
  Instant remain conversational optimizations rather than task-quality policy.
