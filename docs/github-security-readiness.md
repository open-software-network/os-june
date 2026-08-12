# GitHub security readiness

This checklist tracks the repository settings and hygiene items for the public
`open-software-network/os-clovy` source repository.

## Current findings

- The repository is public today.
- The `main` branch is protected by an active ruleset. It requires a pull
  request, one approving review, approval after the latest push, resolved
  review threads, and the `signoff/frontend` and `signoff/rust-macos` checks.
  Force pushes and branch deletion are blocked. CODEOWNERS review is not
  required.
- GitHub code security, Dependabot alerts, Dependabot security updates, secret
  scanning, and secret scanning push protection are disabled.
- GitHub Actions allows all actions and does not require full-length commit SHA
  pinning.
- The `production` and `staging` environments have no protection rules, and
  admins can bypass them.
- The repository includes `SECURITY.md`.
- Wiki and projects are enabled, and branches are not deleted after merge.

## Remaining improvements

- Enable GitHub private vulnerability reporting and point it at
  `SECURITY.md`.
- Enable Dependabot alerts, Dependabot security updates, secret scanning, and
  secret scanning push protection.
- Consider requiring CODEOWNERS review on `main`.
- Configure the `production` environment with required reviewers and disable
  admin bypass. Consider doing the same for `staging`.
- Enable Actions SHA pinning after this PR lands, then keep third-party actions
  pinned by commit SHA.
- Consider restricting Actions to GitHub-owned and selected third-party actions
  already used by this repository.
- Disable wiki if it is unused, enable delete branch on merge, and keep default
  workflow permissions at read-only.

## Audit notes

- Secret-oriented scans did not find committed `.env` files, private keys,
  signing certificates, or generated dependency directories.
- `cargo audit --file clovy-api/Cargo.lock` is clean.
- `cargo audit --file src-tauri/Cargo.lock` reports no vulnerabilities after
  the desktop crate was moved off SQLx's umbrella package.
- The desktop lockfile still includes Linux GTK warnings through Tauri's Linux
  webview stack. If Linux releases are added, revisit those warnings before
  shipping that target.
