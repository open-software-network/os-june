# Local CI signoff

June uses local signoff for PR checks that are either expensive or slow during
agent iteration.

The `desktop` workflow still runs cheap hosted checks on PRs and still runs the
full suite after changes merge to `main`. On PRs, two hosted jobs are replaced
by local commit statuses:

- `Frontend lint and tests` is replaced by `signoff/frontend`.
- `Tauri Rust clippy and tests` is replaced by `signoff/rust-macos`.

`Biome check` stays in hosted PR CI because it is quick and catches formatting,
lint, and banned-import mistakes before review.

## One-time setup

Install GitHub CLI and the Basecamp signoff extension:

```sh
gh auth login
gh extension install basecamp/gh-signoff
```

## Sign off on a PR commit

From a clean pushed branch:

```sh
git push -u origin HEAD
make signoff-pr
```

`make signoff-pr` compares the branch with the PR base, runs the tests needed
for the changed paths, and posts both required statuses:

- `signoff/frontend`
- `signoff/rust-macos`

If a status is not relevant to the changed paths, the command posts it as not
applicable without running that test suite. This keeps docs-only PRs mergeable
when repository rulesets require both statuses.

The lower-level commands are available when you want to run one status
explicitly:

```sh
make signoff-frontend
make signoff-rust-macos
```

`make signoff-frontend` runs the same frontend checks that the PR hosted job
used to run:

```sh
pnpm typecheck
pnpm test
```

`make signoff-rust-macos` runs the same Tauri Rust checks that the PR macOS job
used to run:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

If checks pass, the command posts the matching `signoff/*` status to the current
pushed commit. If the branch changes later, run `make signoff-pr` again for the
new HEAD.

## Force cloud macOS CI

Add labels to a PR when a cloud-hosted verification run is useful:

- `run-frontend-ci` enables hosted frontend typecheck and Vitest.
- `run-macos-ci` enables hosted Tauri Rust clippy and tests on macOS.

You can also run `desktop` manually from the Actions tab.

## Enforce the signoff

To require local signoff before merge, add these required status checks to the
existing `main protection` repository ruleset:

- `signoff/frontend`
- `signoff/rust-macos`

Do not run `gh signoff install` in this repository. That command writes classic
branch protection and can bypass the repo's existing ruleset-based protection.
