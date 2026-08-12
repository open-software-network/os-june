<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read
`specs/003-conversation-turns/plan.md`.

<!-- SPECKIT END -->

# Clovy — Agent Instructions

## Project

Clovy is a private-by-architecture **Tauri desktop app** for meeting notes: it
records a meeting or dictation, transcribes the audio, turns the transcript
into a structured note, and hosts an AI agent you can chat with over your
notes. The frontend is **React** (`src/`), the native shell is **Rust**
(`src-tauri/`), and a confidential **Rust backend, Clovy API** (`clovy-api/`),
proxies all upstream AI and runs metered billing. Identity and credits come
from **OS Accounts**; the agent harness is a Clovy-owned TypeScript service
built on the **OpenAI Agents SDK**; AI models are served through Clovy's model
routing. Clovy API runs
inside a TEE (Phala) so prompt data is not readable by its own infra.

> Read **[CONTEXT.md](CONTEXT.md)** before naming anything, and
> **[docs/index.md](docs/index.md)** to find the doc for the area you touch.

## OS Platform (shared brain)

Platform-enabled repo — Product `june`, Team `os-core`, Issue prefix `JUN`.
The product handle and issue prefix are retained June-era technical identities;
the current product name is Clovy (see
[ADR-0055](docs/adr/0055-clovy-technical-identity-migrates-through-a-compatibility-bridge.md)).
Use the `os_platform_*` MCP tools (https://platform-api.opensoftware.co/mcp);
REST fallback `https://app.opensoftware.co/api` + `Authorization: Bearer
$OS_PLATFORM_API_KEY`. Never print or store credentials.

**Before work that will produce a branch** (skip for Q&A, typos, exploration, CI):
1. `os_platform_get_product{handle:"june"}` — response embeds the Product
   Memory index; `os_platform_get_memory` only entries whose description touches
   your task.
2. Find-or-create the Issue: `os_platform_search_product_issues` first; create
   only if no open Issue matches the outcome. One Issue per independently
   reviewable outcome; reuse it across sessions.
3. Set the Issue `in_progress` (`os_platform_set_issue_status` with the Product
   handle, Issue number, and status), branch `JUN-<number>-<slug>`, and
   put `JUN-<number>` in commit subjects and the PR title/body. PR-Links
   advances in_review/completed automatically where installed; if it doesn't,
   set them yourself. Leave unfinished work in its true status.

**After the work lands**: for each durable fact (decision, convention, gotcha
that cost >10 min) — check the memory index, then `os_platform_create_memory` or
`os_platform_update_memory` the existing slug; never a near-duplicate, never
secrets, never a local notes file.

**Posts** (`os_platform_create_post{team:"os-core"}`): only when a teammate
would act differently for reading it — blocked and stopping, a decision that
changes someone's work, a shipped result the derived events don't convey, or a
start of cross-person/cross-session work. Normally ≤1 per Issue per day. Read
`os_platform_get_team_timeline` before asking anyone "what's the status?".

**No access** (no MCP tools, no key): say once — "OS Platform not configured;
see README → OS Platform" — then work normally, fully offline. No local memory
substitute; put durable learnings in the PR description. At handoff, state
"platform sync skipped"; never imply the platform steps ran.

## Structure

```
os-clovy/
├── src/                     # React frontend
│   ├── app/                 # app shell, routing, update-decision
│   ├── components/          # agent (chat), settings, account, onboarding, note-editor, recorder, sidebar, ...
│   ├── lib/                 # agent runtime contracts, model privacy, Tauri bindings, ...
│   ├── styles/              # app.css + tokens.css (design tokens)
│   └── test/                # vitest suites (all frontend tests live here)
├── src-tauri/               # Rust native shell (Cargo package `clovy`)
│   ├── src/audio/           # recording, source separation, turn detection, live preview
│   ├── src/agent_runtime/   # sidecar protocol, tools, persistence, and migration
│   ├── src/os_accounts.rs   # OS Accounts login (PKCE), keychain token store
│   ├── src/providers/       # model-settings persistence
│   ├── src/commands.rs      # the Tauri command surface
│   └── native/              # macOS system-audio helper (Swift) + dictation helper
├── clovy-api/               # Rust backend (Cargo workspace, crates prefixed `clovy-`)
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
  binding (dictation vs note transcription, Source vs channel, agent harness
  vs model, credit price vs cost, stored vs runtime session id).
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
- [no-all-caps](spec/no-all-caps.md) — no ALL CAPS in UI, no `text-transform: uppercase`
- [icons-central-only](spec/icons-central-only.md) — icons from `central-icons` / `central-icons-filled` only (never lucide)
- [design-tokens](spec/design-tokens.md) — use the variables in `src/styles/tokens.css`
- [type-scale](spec/type-scale.md) — font sizes only from `--fs-*`; headings follow the mapping table
- [font-weights](spec/font-weights.md) — only 400 and `var(--fw-medium)`, never raw 500/600/700
- [font-families](spec/font-families.md) — sans is the voice; serif for headings/display, mono for code
- [control-sizes](spec/control-sizes.md) — control heights from `--control-*`, no raw min/max-heights
- [scroll-fade](spec/scroll-fade.md) — clipped scrollers use the shared `useScrollFade` + `.scroll-fade` / `.scroll-fade-mask` primitive
- [package-install-security](spec/package-install-security.md) — pnpm-only; new package installs go through `sfw`; 7-day `minimumReleaseAge` cooldown
- [mcp-tool-naming](spec/mcp-tool-naming.md) — Clovy-owned in-loop host tools are `verb_object`; the owning PRD or contract names them before the code is written

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
- whether it **needs a Clovy API (backend) deploy** to work end to end (a desktop
  change that depends on an unshipped Clovy API change will not work until Clovy
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
symlink in the same change. Current project skills: `os-design`, `os-platform`,
`os-accounts-integration`, `os-rust-backend`, `os-rust-backend-ci`,
`os-task-prep`, `repo-build-pr`, `repo-review`, `repo-delegate`,
`repo-orchestrate`, `repo-retrospect`, `browser-test-tauri-fe`, `agent-e2e-qa`, plus the Spec
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

### Collaboration (build, delegate, review)

`repo-build-pr` is the entry-point skill; implementation can be delegated
across harnesses (`with codex`), reviews always run on a harness that did not
write the diff, and trust levels are explicit (OS sandbox vs policy-level).
See `docs/agents/collaboration.md` for the map.

## Build, test, lint

Package manager: `pnpm`, the only package manager for this repo, pinned by the
`packageManager` field in `package.json` (CI's `pnpm/action-setup` reads the
same pin — bump it in one place, to the newest release at least 7 days old).
Supply-chain rules — the `sfw` install
wrapper, the 7-day `minimumReleaseAge` cooldown, and deny-by-default dependency
build scripts in `pnpm-workspace.yaml` — live in
[spec/package-install-security.md](spec/package-install-security.md).

- **Run the app:** `pnpm tauri:dev` (builds `src-tauri` and launches the native
  app; the first build is slow). `pnpm dev` runs the Vite frontend only.
- **Frontend tests:** `pnpm test` (vitest; all suites live in `src/test/**`).
  The runner can exit non-zero from `hud-meeting.test.ts` teardown noise despite
  0 real failures — judge by the failure count. Composer/ProseMirror tests can
  flake with a `localsInner` crash under machine load (a `@tiptap/pm` duplicate,
  not a regression). On **Node 26** the `font-scale` and `referral-nudge`
  storage tests fail locally (experimental web storage shadows jsdom's
  `localStorage`); run `NODE_OPTIONS=--no-experimental-webstorage pnpm test`
  and do not "fix" the tests.
- **Rust tests:** `pnpm test:rust` (src-tauri) and `pnpm test:clovy-api` (the
  backend workspace).
- **Agent runtime gate:** `pnpm agent-runtime:typecheck` +
  `pnpm agent-runtime:test` + `pnpm agent-runtime:build` before changing the
  sidecar or its OpenAI Agents SDK pin.
- **Lint / format:** `pnpm check` (Biome: format + lint for `src/` and
  `scripts/`, including the lucide import ban) and `pnpm typecheck`
  (`tsc --noEmit`); `pnpm format` / `pnpm check:write` apply Biome fixes. Rust
  uses `cargo fmt` / `cargo clippy` (config lives under `src-tauri/` and
  `clovy-api/`). Biome ratchets high-volume retrofit rules (a11y, hook-deps,
  non-null assertions) to `warn` in `biome.json`; keep new code clean and fix
  the warnings incrementally. Never leave checks broken.
- **CI parity:** `make verify` runs the full gate locally (Biome, typecheck,
  vitest, and `cargo fmt`/`clippy`/`test` for both Rust crates); `make help`
  lists every target. A green `make verify` should mean green CI. It adds
  `cargo clippy --all-targets`, which the narrower targets skip — "green" from
  `cargo test` + `pnpm test` alone is **not** CI-green.
- **A red gate that is not your bug:** see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
  before chasing one — Node 26 storage tests, vitest teardown exit codes,
  ProseMirror flake, `cargo test --lib` missing the integration suites, pnpm's
  non-TTY purge prompt (`CI=true`), and 1Password-locked signing/push failures
  are all documented false alarms.

## Boundaries

- **Clovy-canonical identity migrates through a compatibility bridge.** New
  package, service, environment, credential, storage, native-host, deep-link,
  and artifact names use Clovy. Preserve every released June-era reader with
  canonical-first fallback, copy-on-read, dual-write, or published aliases as
  appropriate. Keep immutable bundle, executable, updater, OS Platform, and
  externally provisioned identities until a verified transfer exists. Never
  remove an alias without satisfying the retirement gates in
  [ADR-0055](docs/adr/0055-clovy-technical-identity-migrates-through-a-compatibility-bridge.md).
- **Service-managed upstream provider keys live only in Clovy API, never in the desktop binary.**
  The app calls Clovy API over `/v1/*`; Clovy API holds the Venice/OpenAI service
  keys and the OS Accounts App API key. A user's explicit Venice BYOK credential
  is the exception: Clovy stores it locally and forwards it only on eligible
  Venice requests.
- **Clovy API must stay backward-compatible — no breaking changes.** Clovy ships
  and auto-updates in production, so installs in the wild keep calling older
  `/v1/*` contracts. Never remove or repurpose an existing endpoint, request
  field, or response shape; add new optional fields or new endpoints instead. A
  breaking API change strands every app version that has not updated yet.
- **Clovy presents as Clovy.** The local harness is an implementation detail;
  product instructions assert Clovy's identity.
- **Identity and credits are OS Accounts'.** Clovy is an on-device client of OS
  Accounts and never owns user or wallet state. The dependency arrow points
  Clovy → OS Accounts, never the reverse.
