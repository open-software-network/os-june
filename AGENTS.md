<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read
`specs/003-conversation-turns/plan.md`.

<!-- SPECKIT END -->

# June — Agent Instructions

## Project

June is a private-by-architecture **Tauri desktop app** for meeting notes: it
records a meeting or dictation, transcribes the audio, turns the transcript
into a structured note, and hosts an AI agent you can chat with over your
notes. The frontend is **React** (`src/`), the native shell is **Rust**
(`src-tauri/`), and a confidential **Rust backend, June API** (`june-api/`),
proxies all upstream AI and runs metered billing. Identity and credits come
from **OS Accounts**; the agent brain is an embedded, pinned build of the
**Hermes** runtime; AI models are served through **Venice**. June API runs
inside a TEE (Phala) so prompt data is not readable by its own infra.

> Read **[CONTEXT.md](CONTEXT.md)** before naming anything, and
> **[docs/index.md](docs/index.md)** to find the doc for the area you touch.

## Structure

```
os-june/
├── src/                     # React frontend
│   ├── app/                 # app shell, routing, update-decision
│   ├── components/          # agent (chat), settings, account, onboarding, note-editor, recorder, sidebar, ...
│   ├── lib/                 # hermes-gateway, hermes-control-plane/, model-privacy, tauri bindings, ...
│   ├── styles/              # app.css + tokens.css (design tokens)
│   └── test/                # vitest suites (all frontend tests live here)
├── src-tauri/               # Rust native shell (Cargo package `os-june`)
│   ├── src/audio/           # recording, source separation, turn detection, live preview
│   ├── src/hermes_bridge.rs # spawns + sandboxes the embedded Hermes agent runtime
│   ├── src/os_accounts.rs   # OS Accounts login (PKCE), keychain token store
│   ├── src/providers/       # model-settings persistence
│   ├── src/commands.rs      # the Tauri command surface
│   └── native/              # macOS system-audio helper (Swift) + dictation helper
├── june-api/                # Rust backend (Cargo workspace, crates prefixed `june-`)
│   └── crates/              # domain / services / providers / config / api / app  (hexagonal)
├── docs/                    # see docs/index.md — ADRs, subsystem docs, runbooks, PRDs, QA
├── specs/                   # Spec Kit feature specs (001-003)
├── spec/                    # enforceable coding rules (see spec/index.md) — distinct from specs/
├── scripts/                 # build / dev / release tooling
├── CONTEXT.md               # domain glossary — canonical names
├── AGENTS.md                # this file (canonical); CLAUDE.md is a symlink to it
└── .agents/skills/          # vendored agent skills, symlinked into .claude/skills/
```

## Domain & decisions — read before writing code

- **[CONTEXT.md](CONTEXT.md)** — the domain glossary / ubiquitous language.
  Read before naming anything; terms are canonical and the `_Avoid_` lists are
  binding (dictation vs note transcription, Source vs channel, Hermes vs "the
  model", credit price vs cost, stored vs runtime session id).
- **[docs/index.md](docs/index.md)** — the annotated index of every doc: ADRs,
  subsystem docs, release/ops runbooks, PRDs, QA, and the feature specs.
- **[docs/adr/](docs/adr/)** — Architecture Decision Records. Read the ADRs for
  the area you are touching before proposing structural change; **do not
  re-litigate accepted decisions.** Append-only: supersede with a new ADR (or a
  dated addendum), never rewrite the decision. Numbering: scan `docs/adr/` for
  the highest `NNNN-*.md` and increment.
- **[specs/003-conversation-turns/plan.md](specs/003-conversation-turns/plan.md)**
  — the current feature spec; its plan doubles as the tech-stack and
  shell-command reference for new agents.

### When to add an ADR (proactive)

Record a decision as an ADR when **all three** hold:

1. **Hard to reverse** — real cost to change later (architectural shape, an
   integration/wire contract, tech lock-in, a boundary).
2. **Surprising without context** — a future reader will ask "why on earth is
   it done this way?".
3. **A real trade-off** — genuine alternatives existed and one was chosen for
   specific reasons.

Skip it if the change is easily reversible, the obvious choice, or had no real
alternative. Offer an ADR proactively (do not wait to be asked) when you reject
a refactor for a load-bearing reason, deviate deliberately from the obvious
path, or encode a constraint not visible in the code. If you sharpen or add a
domain term mid-discussion, update **CONTEXT.md** in the same change.

## Specs (enforceable rules)

Enforceable coding rules live in **[spec/index.md](spec/index.md)**, one file
per rule (Rule / Why / How to apply / Exceptions). **Read every spec in your
scope before writing code; violations should fail review.** When you add,
rename, or remove a spec, update `spec/index.md` in the same commit. (These are
distinct from the `specs/` Spec Kit feature specs.)

- [sentence-case](spec/sentence-case.md) — sentence case for all UI labels (never ALL CAPS / uppercase)
- [no-typographic-dashes](spec/no-typographic-dashes.md) — no en/em dashes in user-facing copy (hyphen or "to")
- [icons-central-only](spec/icons-central-only.md) — icons from `central-icons` / `central-icons-filled` only (never lucide)
- [design-tokens](spec/design-tokens.md) — use the variables in `src/styles/tokens.css`

## PR and description conventions

When drafting PR titles, PR descriptions, issue summaries, release notes, or
other project copy, avoid naming or comparing against other products unless the
user explicitly asks for that context or the reference is required for a
concrete integration, compatibility note, migration, or legal attribution.
Prefer describing the behavior, workflow, or category generically.

Every PR description should state (the template in
`.github/pull_request_template.md` has these sections):

- whether the change was **tested visually** — for UI changes, attach a
  screenshot or recording;
- whether it **needs a June API (backend) deploy** to work end to end (a desktop
  change that depends on an unshipped June API change will not work until June
  API is deployed);
- the **root cause**, for bug fixes (the actual cause, not just the symptom);
- what is deliberately **out of scope**;
- any **followups** it sets up or defers (link issues where possible).

## Skills

Vendored agent skills live in **`.agents/skills/`** (the single source of truth)
and **every skill is symlinked into `.claude/skills/`**. A skill must never exist
only under `.claude/`, and a `.claude/skills/<name>` entry must always be a
symlink to `../../.agents/skills/<name>` — never a real directory. Add a new
skill under `.agents/skills/<name>/` and create the `.claude/skills/<name>`
symlink in the same change. Current project skills: `os-platform`,
`os-accounts-integration`, `os-rust-backend`, `os-rust-backend-ci`,
`os-task-prep`, `repo-build-pr`, `repo-review`, `repo-delegate`,
`repo-orchestrate`, `browser-test-tauri-fe`, `agent-e2e-qa`, plus the Spec
Kit workflow skills (`speckit-*`). `make skills-update` /
`skills-restore` / `skills-sync` (thin wrappers over `npx skills`) refresh,
restore from the lockfile, or re-link them.

## Agent skills

### Issue tracker

Issues live on the Open Software platform (os-platform), org `june` — not
GitHub Issues. Read/search/take via the `os-platform` skill script; writes go
through the documented platform API with an append-only, probe-then-verify
discipline. See `docs/agents/issue-tracker.md`.

### Triage labels

Hybrid mapping: `needs-triage` / `needs-info` / `ready-for-human` are platform
labels; "ready-for-agent" = status `todo` + os-task-prep enrichment; "wontfix"
= status `cancelled`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` (canonical glossary, binding _Avoid_
lists) + `docs/adr/`. See `docs/agents/domain.md`.

## Build, test, lint

Package manager: `pnpm` (a `bun.lock` also exists; the scripts are
runner-agnostic).

- **Run the app:** `pnpm tauri:dev` (builds `src-tauri` and launches the native
  app; the first build is slow). `pnpm dev` runs the Vite frontend only.
- **Frontend tests:** `pnpm test` (vitest; all suites live in `src/test/**`).
  The runner can exit non-zero from `hud-meeting.test.ts` teardown noise despite
  0 real failures — judge by the failure count. Composer/ProseMirror tests can
  flake with a `localsInner` crash under machine load (a `@tiptap/pm` duplicate,
  not a regression).
- **Rust tests:** `pnpm test:rust` (src-tauri) and `pnpm test:june-api` (the
  backend workspace).
- **Hermes pin gate:** `pnpm test:hermes-smoke` + `pnpm hermes:upgrade-check`
  before bumping the pinned Hermes runtime (see
  [docs/hermes-upgrade-checklist.md](docs/hermes-upgrade-checklist.md)).
- **Lint / format:** `pnpm check` (Biome: format + lint for `src/` and
  `scripts/`, including the lucide import ban) and `pnpm typecheck`
  (`tsc --noEmit`); `pnpm format` / `pnpm check:write` apply Biome fixes. Rust
  uses `cargo fmt` / `cargo clippy` (config lives under `src-tauri/` and
  `june-api/`). Biome ratchets high-volume retrofit rules (a11y, hook-deps,
  non-null assertions) to `warn` in `biome.json`; keep new code clean and fix
  the warnings incrementally. Never leave checks broken.
- **CI parity:** `make verify` runs the full gate locally (Biome, typecheck,
  vitest, and `cargo fmt`/`clippy`/`test` for both Rust crates); `make help`
  lists every target. A green `make verify` should mean green CI.

## Boundaries

- **Upstream provider keys live only in June API, never in the desktop binary.**
  The app calls June API over `/v1/*`; June API holds the Venice/OpenAI keys and
  the OS Accounts App API key.
- **June API must stay backward-compatible — no breaking changes.** June ships
  and auto-updates in production, so installs in the wild keep calling older
  `/v1/*` contracts. Never remove or repurpose an existing endpoint, request
  field, or response shape; add new optional fields or new endpoints instead. A
  breaking API change strands every app version that has not updated yet.
- **June presents as June, never as Hermes.** The embedded runtime is an
  implementation detail; an injected `SOUL.md` asserts June's identity.
- **Identity and credits are OS Accounts'.** June is an on-device client of OS
  Accounts and never owns user or wallet state. The dependency arrow points
  June → OS Accounts, never the reverse.
