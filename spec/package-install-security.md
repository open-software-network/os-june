# Package install security

**Rule.** `pnpm` is the only JS/TS package manager in this repo — never
introduce bun/npm/yarn lockfiles. Every command that brings new package code
into the tree (`pnpm add`, `pnpm update`, `pnpm dlx`, `cargo add`,
`cargo install`, `cargo update`) runs through Socket Firewall:
`sfw <command>`. Dependency versions younger than 7 days are refused by
`minimumReleaseAge` in `pnpm-workspace.yaml`; cargo gets the same cooldown
from `scripts/check-cargo-release-age.py` (cargo has no native equivalent —
rust-lang/cargo#15973), which CI runs on any `Cargo.lock` change. Do not
lower the cooldown or add exclusions without a review-visible justification.

**Why.** Supply-chain attacks land through freshly published malicious
versions of trusted packages. The 7-day cooldown outlives the typical
publish-to-takedown window; Socket Firewall blocks known-malicious packages
at download time (zero-config, no account); a single package manager keeps
one auditable lockfile.

**How to apply.** Install the wrapper once with `npm i -g sfw`, then prefix
installs: `sfw pnpm add <pkg>`, `sfw cargo add <crate>`. Claude Code enforces
this via a PreToolUse hook (`scripts/hooks/require-sfw.py`); agents on other
harnesses follow this spec directly. For an urgent security patch inside the
7-day window, use `pnpm audit --fix` — it adds the patched version to
`minimumReleaseAgeExclude`; for a crate, add `name@version # reason` to
`scripts/cargo-release-age-exclude.txt`. Commit either change with the
reason. New dependency
build scripts are deny-by-default: read the script before approving it in
`allowBuilds` in `pnpm-workspace.yaml`.

**Exceptions.** Lockfile-respecting restores (`pnpm install` with no package
argument, `--frozen-lockfile` in CI, `cargo build`/`cargo fetch` against a
committed `Cargo.lock`) resolve nothing new and need no wrapper.
