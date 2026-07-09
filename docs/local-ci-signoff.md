# Local CI signoff

June uses local signoff for the expensive macOS desktop Rust PR gate.

The `desktop` workflow still runs cheap Linux checks on PRs and still runs the
full macOS Rust clippy/test job after changes merge to `main`. On PRs, the
macOS Rust job is replaced by a local commit status named
`signoff/rust-macos`.

## One-time setup

Install GitHub CLI and the Basecamp signoff extension:

```sh
gh auth login
gh extension install basecamp/gh-signoff
```

## Sign off on a PR commit

From a clean branch on macOS:

```sh
git push -u origin HEAD
make signoff-rust-macos
```

`make signoff-rust-macos` runs the same Tauri Rust checks that the PR macOS job
used to run:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

If they pass, the command posts `signoff/rust-macos` to the current pushed
commit. If the branch changes later, run the command again for the new HEAD.

## Force cloud macOS CI

Add the `run-macos-ci` label to a PR when a cloud-hosted macOS verification run
is useful. The label reruns the `desktop` workflow and enables the
`Tauri Rust clippy and tests` job for that PR.

You can also run `desktop` manually from the Actions tab.

## Enforce the signoff

To require local macOS signoff before merge, add required status check
`signoff/rust-macos` to the existing `main protection` repository ruleset.

Do not run `gh signoff install` in this repository. That command writes classic
branch protection and can bypass the repo's existing ruleset-based protection.
