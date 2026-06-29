<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read
`specs/003-conversation-turns/plan.md`.

<!-- SPECKIT END -->

## UI conventions

See the "UI conventions" section in [CLAUDE.md](CLAUDE.md) — sentence-case
labels, **no en-dashes (–) or em-dashes (—) in user-facing copy** (hyphen
or "to" for ranges; rewrite asides with a period, comma, colon, or
parentheses), design tokens from
`src/styles/tokens.css`, and **icons from `central-icons` /
`central-icons-filled` only (never lucide-react or any other icon set;
lucide was deliberately removed from the dependencies)**.

## Cursor Cloud specific instructions

The Cloud Agent VM is **Linux**. Standard commands live in the README
"Development commands" section and `package.json` scripts; only the
non-obvious caveats are noted here.

### What runs on this Linux VM vs. what does not

- **Runnable here:** the React/Vite frontend (`pnpm dev` → `http://127.0.0.1:1421`)
  and the `june-api` Rust backend (`cd june-api && cargo run -- serve` →
  `http://127.0.0.1:8080`). Lint (`pnpm lint`), frontend tests (`pnpm test`),
  and `june-api` tests (`pnpm test:june-api`) all run here.
- **Not runnable here:** the **Tauri desktop app** (`src-tauri`,
  `pnpm tauri:dev`/`pnpm tauri:build`) is macOS/Windows-only (native macOS
  system-audio helper, `Info.plist`, Seatbelt write-jail; `scripts/tauri-dev.mjs`
  ships only `darwin`/`win32` configs). Its Rust tests (`pnpm test:rust`) run
  only on `macos-latest` in CI (`.github/workflows/desktop.yml`). Do not try to
  build/run the desktop app on Linux.
- Opening the frontend in a plain browser renders the real welcome screen but
  most interactive flows (recording, notes) need the Tauri IPC runtime and will
  throw `transformCallback` errors in a browser. That is expected, not a bug.

### Node version gotcha (affects `pnpm test`)

The system `/exec-daemon/node` is **22.14.0**, whose `BroadcastChannel`/jsdom
interaction throws hundreds of uncaught exceptions on vitest teardown and makes
`pnpm test` exit non-zero **even though every test passes**. The fix is already
applied: `~/.bashrc` prepends nvm **Node 22.22.2** (which also bundles the
pinned `pnpm 9.15.4`) ahead of the system node, so login shells run the good
version. If `node -v` ever reports `22.14.0`, run tests with
`PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"` (or `nvm use default`).

### june-api backend

- Requires Rust **1.95** (pinned in `june-api/rust-toolchain.toml`); rustup
  auto-installs it on first `cargo` run, and the update script pre-installs it.
- No database or other external service is needed; tests mock upstreams with
  `wiremock`.
- Runs in **open source local mode** by default (`.env` + `june-api/.env` copied
  from the `*.env.example` files). Local mode needs **no OS Accounts login**: the
  desktop client and `june-api` share the bearer token `local-dev-token`.
- **Real note transcription/generation/dictation requires a provider key.** Set
  `JUNE__UPSTREAMS__VENICE__API_KEY` (and optionally
  `JUNE__UPSTREAMS__OPENAI__API_KEY`) in `june-api/.env`. Without it, `/v1/models`
  returns `[]` and the notes endpoints reject with `model_not_priced`. The
  health (`/livez`, `/readyz`, `/healthz`) and auth/validation paths work without
  any key.
