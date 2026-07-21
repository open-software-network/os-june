# Home assistant experiment

Home is June's persistent, relationship-level conversation. It is distinct
from a focused **agent session**: Home holds the ongoing personal-assistant
thread, while agent sessions hold concrete work that can be opened, monitored,
and continued independently.

This document owns the experimental `june_home` MCP contract. The experiment
is intentionally local and reversible, so it does not introduce a new June API
contract or an ADR.

## Product contract

- Each Hermes profile has at most one stored Home session id on this device.
- Home starts on Auto (Lower) so ordinary conversation favors the fastest
  eligible private model. The composer keeps the existing model picker, and an
  explicit choice wins for that Home conversation at the next agent-run
  boundary under ADR 0018.
- Home never appears as a duplicate item in the Sessions list.
- A concrete task may become a focused agent session without navigating away
  from Home. The focused session inherits the current new-session model and
  Runtime mode defaults, starts in the background, and appears in the sidebar.
- A task handoff is shown inline in Home. Selecting it opens the focused
  session with the normal agent-session UI.
- Home keeps lightweight suggestion nudges above the composer. They prefill the
  empty conversation and never run work without the user's Send.
- Sending locally echoes the user's bubble and June's typing bubble before the
  runtime finishes resuming or creating the persisted Home session.

## Hidden Home context

Every Home prompt is prefixed at runtime with a `[June home context]` block.
The block is not rendered in the transcript. It tells June that this is the
persistent personal-assistant thread and that focused work should be handed to
the `june_home` MCP server rather than performed inline.

## `june_home` MCP server

| Tool | Input | Result | Meaning |
| --- | --- | --- | --- |
| `start_task` | `title` (string), `prompt` (string), optional `summary` (string) | The normalized task request | Ask the June desktop client to create and start a focused agent session. |

`start_task` is a signal, not a session store. The MCP server validates and
echoes the request. The Home client observes the completed tool call, creates
the Hermes session through the existing gateway, starts its first agent run,
and records the returned stored session id on the inline handoff card.

The model must call `start_task` only while the hidden Home context is present,
only for requests that benefit from focused work or background execution, and
at most once per distinct task. Conversation, quick answers, clarifying
questions, and preference updates stay in Home.
