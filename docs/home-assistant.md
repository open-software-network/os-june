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
- Home uses Auto at the Economy preference with Low reasoning so ordinary
  conversation favors the fastest eligible private model. Home does not expose
  the model picker or `/model`; a one-time migration moves older Home threads
  onto this route.
- Home never appears as a duplicate item in the Sessions list.
- Home is currently macOS-only because the Windows build does not bundle the
  Hermes runtime needed to create and resume its backing session.
- A concrete task may become a focused agent session without navigating away
  from Home. The focused session uses the normal new-session model, reasoning,
  and Runtime mode defaults, starts in the background, and appears in the
  sidebar. Home's implicit speed-first route never leaks into task work.
- A task handoff is shown inline in Home. Selecting it opens the focused
  session with the normal agent-session UI.
- Home keeps lightweight suggestion nudges above the composer. They prefill the
  empty conversation, follow the local time of day, and never run work without
  the user's Send.
- Sending locally echoes the user's bubble and June's typing bubble before the
  runtime finishes resuming or creating the persisted Home session. June API
  response deltas then stream over a Tauri channel into the normal smoothed
  markdown renderer.

## Home conversation paths

Ordinary text-only Home turns use the lightweight native `june_home_chat` path.
It sends a compact relationship prompt and one structured `start_task` tool,
which avoids loading the full Hermes agent prompt and tool catalog for a short
conversation. The selected Home model and reasoning effort are captured at the
Send boundary and passed through to this request. Auto Economy and Low are
fixed Home defaults, not visible composer choices.

The lightweight path has no live external sources. Clear requests for news,
weather, prices, scores, schedules, current events, or what is happening today
force the `start_task` tool rather than trusting the model to volunteer a
handoff. Home suppresses any inline model text for those turns and fails the
turn if the structured handoff is missing. The resulting focused session
receives the exact user request plus a hidden requirement to use `web_search`
and `web_fetch`, verify time-sensitive claims against current sources, and
include source links. A bounded excerpt of the recent Home conversation travels
with that hidden context, together with any selected older-thread excerpts, so
follow-ups can resolve references without treating prior factual claims as
verified. If sources cannot be retrieved, it must say so rather than answer
from model memory.

When memory is enabled, the native command also loads a bounded snapshot of the
Send-time profile's most recent global on-device memories: at most 12 items,
400 characters each, and 4,000 characters total. Capturing that profile with
the message prevents a queued request from crossing memory boundaries if the
user changes profiles while an earlier reply is streaming. The model receives
memories as background facts rather than instructions and is told to use only
relevant ones. Project-scoped memories are excluded because Home has no active
project boundary.

Turns that need Hermes — attachments, slash commands, and other agent features
— are prefixed at runtime with a hidden `[June home context]` block. It tells
June that this is the persistent personal-assistant thread and that focused
work should be handed to the `june_home` MCP server rather than performed
inline. The block is not rendered in the transcript.

Both paths emit the same structured task request and render the same inline
handoff card. A process-wide queue keyed by the stored Home session id
serializes fast-path replies across Home navigation. The transcript is merged
chronologically from persisted stable turn ids so an older reply cannot
overwrite newer turns. The on-device visual transcript preserves the complete
direct thread while WebView storage allows it. If a storage quota rejects the
full record, persistence retries with recent tails of 2,000, 1,000, and finally
400 turns so the newest exchange is not lost.

Each lightweight model request gets up to the newest 80 eligible messages or
48,000 characters, whichever boundary comes first. It drops a leading orphan
assistant turn if that window cuts through an exchange. From the older
transcript, the client also selects up to 24 chronologically ordered excerpts,
bounded to 12,000 characters: relevant prior exchanges, explicit preference
language, the newest older exchanges, and a small longitudinal sample. These
are labeled as past conversation data rather than instructions. The native
command applies a second defensive ceiling of 96 recent messages or 64,000
characters and 12,000 characters of older excerpts.

This separation makes Home feel like one continual thread without pretending a
model has an infinite context window. The recent-message window and older
excerpts provide conversational continuity; the profile-scoped memory snapshot
above remains the durable place for preferences the user explicitly asks June
to remember.

If a fast-path call fails before a reply is committed, the original text is
restored as the persisted composer draft when the composer is still empty. If
the user has already begun another draft, the sent bubble remains in the
thread, so recovering the failed send never overwrites or silently loses newer
input. Transport diagnostics stay in error details and logs; the primary Home
error is a short retryable message.

The merged transcript is currently a UI contract rather than one shared model
context for every capability. A Hermes turn that needs an attachment or slash
command does not yet receive the lightweight path's full local history. Do not
describe the entire visible Home transcript as shared semantic context until
this boundary has a retrieval or summary contract.

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
distinct task. Conversation, quick answers, and clarifying questions stay in
Home. An explicit request to remember or update a lasting preference is handed
to a focused session so it can use June's on-device memory tools; the
lightweight path can use the resulting global memory on later requests, but
must not promise recall until the focused session has actually saved it.

## Amendments

- The initial experiment routed every Home message through Hermes and the
  `june_home` MCP server. Latency testing showed that the full agent prefill was
  a poor default for ordinary conversation, so text-only turns now use the
  equivalent lightweight structured-tool path described above.
- The initial handoff draft inherited the model shown in Home. Focused work now
  deliberately returns to the normal new-session defaults captured at the Home
  Send boundary, so Auto Economy and Low remain conversational optimizations
  rather than task-quality policy.
