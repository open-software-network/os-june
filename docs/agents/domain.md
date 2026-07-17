# Domain Docs

How the engineering skills should consume this repo's domain documentation.

This is a **single-context** repo: one glossary covers the React frontend
(`src/`), the Tauri shell (`src-tauri/`), and the june-api backend
(`june-api/`). There is no `CONTEXT-MAP.md`.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the canonical glossary / ubiquitous
  language. Glossary sections: Platform, Notes, Audio & recording, Agent
  runtime (Hermes), AI work & billing, Desktop shell & updates, June companion. The `_Avoid_`
  lines are **binding**. Its **Flagged ambiguities** section is the quick
  disambiguation table for the six overloaded terms: proxy, transcribe,
  credits, session id, "the model", channel — check it before naming anything.
- **`docs/adr/`** — read the ADRs touching the area you're about to work in.
  ADRs are **append-only**: supersede with a new ADR or dated addendum, never
  rewrite. Numbering: scan for the highest `NNNN-*.md` and increment (the
  numbering is now collision-free through 0035 - keep it that way).

## ADR routing by area

| Working on | Read first |
| --- | --- |
| Updater, releases, channels | 0001 (public releases repo), 0003 (rc channel + promotion) |
| Live transcript preview | 0002 (ephemeral, never source of truth) |
| Audio capture, sources, turns | 0004 (out-of-process system audio helper), 0005 (one WAV per source) |
| Hermes runtime, sandboxing, sessions | 0006 (embedded sandboxed child processes) |
| Model picker, capabilities, pricing | 0007 (capabilities from live Venice catalog, never `traits`) |
| Image generation / editing | 0008 (`/image` fast path + LLM tools) |
| June companion trust, native UI, pairing, relay, and mutation recovery | 0028-0035 (read the supersession chain through 0035) |

## Don't conflate the three doc families

- `CONTEXT.md` + `docs/adr/` — domain language and decisions (this file's
  scope).
- `spec/` — enforceable coding rules (sentence-case, no typographic dashes,
  central icons only, design tokens); violations fail review.
- `specs/` — Spec Kit feature specs; `specs/003-conversation-turns/plan.md`
  doubles as the tech-stack reference.

## Use the glossary's vocabulary

When output names a domain concept (issue title, refactor proposal,
hypothesis, test name), use the term as defined in `CONTEXT.md`. Don't drift
to synonyms the glossary explicitly avoids. If a concept isn't in the
glossary yet, that's a signal — either reconsider the term or note the gap
for `/domain-modeling`. If you sharpen or add a domain term mid-change,
update `CONTEXT.md` in the same change (per AGENTS.md). `CONTEXT.md` states
point-in-time facts (flags, PR status) — verify against code before repeating
them.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather
than silently overriding:

> _Contradicts ADR-0006 (embedded sandboxed Hermes runtime) — but worth
> reopening because…_
