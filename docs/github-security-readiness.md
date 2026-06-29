# GitHub security readiness

This checklist captures the repository settings and hygiene items that should
be in place before making `open-software-network/os-june` public.

## Current findings

- The repository is private today.
- The `main` branch is not protected.
- GitHub code security, Dependabot alerts, Dependabot security updates, secret
  scanning, and secret scanning push protection are disabled.
- GitHub Actions allows all actions and does not require full-length commit SHA
  pinning.
- The `production` and `staging` environments have no protection rules, and
  admins can bypass them.
- The repository has no GitHub security policy configured yet.
- Wiki and projects are enabled, and branches are not deleted after merge.

## Required before going public

- Enable GitHub private vulnerability reporting and point it at
  `SECURITY.md`.
- Enable Dependabot alerts, Dependabot security updates, secret scanning, and
  secret scanning push protection.
- Protect `main` with pull requests, CODEOWNERS review, required status checks,
  stale-review dismissal, and no force pushes or deletions.
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
- `cargo audit --file june-api/Cargo.lock` is clean.
- `cargo audit --file src-tauri/Cargo.lock` reports no vulnerabilities after
  the desktop crate was moved off SQLx's umbrella package.
- The desktop lockfile still includes Linux GTK warnings through Tauri's Linux
  webview stack. If Linux releases are added, revisit those warnings before
  shipping that target.
