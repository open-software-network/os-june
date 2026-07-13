# Package install security

**Rule.** `pnpm` is the only JS/TS package manager in this repo — never
introduce bun/npm/yarn lockfiles. Every agent-issued command that brings new
package code into the tree or executes registry code (`pnpm add`, `pnpm update`,
`pnpm dlx` / `pnpm create`, mutable `pnpm install`, `npx` / `npm exec` /
`npm create`, registry-changing `corepack` commands, `cargo add`, `cargo install`,
`cargo update`) runs through Socket Firewall:
`sfw <command>`. Dependency versions younger than 7 days are refused by
`minimumReleaseAge` in `pnpm-workspace.yaml`; cargo gets the same cooldown
from `scripts/check-cargo-release-age.py` (cargo has no native equivalent —
rust-lang/cargo#15973), which CI runs on any Cargo manifest or lock change. Do not
lower the cooldown or add exclusions without a review-visible justification.
The pnpm version in `package.json#packageManager` is also at least 7 days old;
the shared setup action verifies its publication time before any workflow
downloads and executes it.

**Why.** Supply-chain attacks land through freshly published malicious
versions of trusted packages. The 7-day cooldown outlives the typical
publish-to-takedown window; Socket Firewall blocks known-malicious packages
at download time (zero-config, no account); a single package manager keeps
one auditable lockfile.

**How to apply.** Install the wrapper once with `npm i -g sfw`, then prefix
installs: `sfw pnpm add <pkg>`, `sfw cargo add <crate>`. Claude Code enforces
this via a PreToolUse hook (`scripts/hooks/require-sfw.py`); agents on other
harnesses follow this spec directly. For an urgent security patch inside the
7-day window, use `sfw pnpm audit --fix` — it adds the patched version to
`minimumReleaseAgeExclude`; for a crate, add `name@version # reason` to
`scripts/cargo-release-age-exclude.txt`. Commit either change with the
reason. New dependency
build scripts are deny-by-default: read the script before approving it in
`allowBuilds` in `pnpm-workspace.yaml`, and version-qualify allow entries
(`name@<version>: true`) so a bumped version's script needs a fresh review.

**Exceptions.** The one-time `npm i -g sfw` bootstrap cannot wrap itself.
Explicitly immutable restores (`pnpm install --frozen-lockfile`,
`cargo build`/`cargo fetch` against a committed `Cargo.lock`) resolve nothing
new and need no wrapper. A plain `pnpm install` can update a stale lockfile, so
agents must run it through `sfw`.
