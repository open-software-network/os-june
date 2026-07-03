# 0010 — Note references in agent chat: text token + fetch-by-id tool

- Status: accepted
- Date: 2026-07-03
- Issue: JUN-186

## Context

June's agent can search the user's notes through the `june_context` MCP server
(`search_meeting_notes`), but there was no way to point a chat at a *specific*
note. Users who had just finished a meeting had to describe the note in prose
and hope retrieval surfaced the right one, and search results carry
snippet-capped text (900 chars), so even a correct hit could not feed a whole
note into the conversation.

JUN-186 asked for a way to "copy a link to a notes session and paste it into
June," or alternatively to chat from inside the note view. Several carriers
for the reference were considered:

1. **Inline the note content client-side** — the app pastes the full note
   (and possibly transcript) into the prompt at submit.
2. **A Hermes workspace file attachment** — import the note as a file the way
   `/file` attachments work.
3. **A deep link** (`osjune://note/<id>`) resolved by the shell.
4. **A plain-text reference token resolved by the agent** — the message
   carries `@note:<id>` and the agent fetches content on demand through a new
   `june_context` tool.

## Decision

A note reference is a **plain-text token in the prompt** with the canonical
form:

```
@note:<id> ("<title>")   // title sanitized: whitespace collapsed, quotes
@note:<id>               // stripped, capped at 80 chars; omitted when empty
```

and the `june_context` MCP server gains a read-only **`get_meeting_note`**
tool (`note_id`, optional `include_transcript`, content capped at 60k chars
with explicit truncation flags). SOUL guidance teaches the model to resolve
the token via the tool and to say so when a note is not found.

The composer renders the reference as an atom chip (built on the same TipTap
mention machinery as the category chip) that serializes to the token at send;
"Ask June" in the note view pre-seeds a fresh chat with the chip (never
auto-submits); "Copy note reference" copies the same token for pasting
anywhere a prompt can be typed.

## Rationale

- **One wire format, many affordances.** Because the reference is just text,
  the chip, the copy button, a pasted token, a scheduled/cron prompt, and a
  teammate's pasted message all work identically. Affordances stay UI sugar;
  none of them is load-bearing.
- **Context economy.** Inlining (option 1) bloats every turn with up to an
  entire transcript whether or not the model needs it, and the content
  freezes at submit time. The token defers loading to the model, which can
  choose `include_transcript` only when needed and always reads current
  content.
- **No new trust surface.** Option 2 (workspace file) copies note content
  into the Hermes workspace, creating a second, stale copy of private data
  outside the notes DB; the tool reads the existing SQLite DB read-only.
- **Deep links stay out of scope.** Option 3 requires an OS-level URL route
  (today `osjune://` serves only the OS Accounts auth callback) and only pays
  off for *outside-the-app* linking, which JUN-186 does not require. The
  token does not preclude adding a deep link later that resolves to the same
  id.

## Consequences

- The token format is a compatibility contract between the composer
  serializer, the copy affordance, and the SOUL guidance — change it only
  additively (the agent must keep resolving tokens already embedded in old
  chat transcripts).
- Token-shaped text **is** a reference, everywhere, by design: the agent
  resolves it whether it arrived as a chip, a paste, or literal typing, and
  draft restore renders it as a chip. There is deliberately no "inert" spelling
  of the token; an id that resolves to nothing yields the tool's not-found
  answer rather than silent text.
- `get_meeting_note` evolves additively: new tools/fields only, no
  repurposing (mirrors the June API compatibility boundary in AGENTS.md,
  though this server ships with the app and has no cross-version wire
  exposure).
- Composer drafts persist as the serialized plain text; restoring a draft
  rehydrates `@note:` tokens back into chips (`buildDoc`), which is lossless
  precisely because the chip serializes to the token.
- An inline chat surface inside the note view (the second half of JUN-186)
  remains open as a follow-up; it would reuse the same token + tool.
