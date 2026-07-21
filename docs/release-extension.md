# Releasing the June browser extension

The June Chrome extension is released as part of the desktop RC-to-stable flow.
The RC workflow submits changed extension bytes for Chrome review with deferred
publication. Stable desktop promotion is blocked until Chrome approves that
exact package, then publishes it after the desktop release succeeds.

The architecture and trade-offs are recorded in [ADR 0035](adr/0035-extension-releases-follow-desktop-rc-promotion.md).

## Current bootstrap state (2026-07-21)

- The publisher account is accessible; its publisher ID goes into the
  `CHROME_WEB_STORE_PUBLISHER_ID` variable (Developer Dashboard -> Publisher
  -> Settings).
- The bootstrap `0.1.0` package was uploaded on 2026-07-21 and is pending
  review. The store assigned item ID `jfpogffllplkfoooiaibjkojkngbdnik`; its
  public key (item -> Package tab) is mirrored into
  `extension/public/manifest.json` `key` and the ID into `EXTENSION_ID` in
  `src-tauri/src/extension_host.rs`, so load-unpacked builds share the store
  item's ID. The store owns the keypair - if the item is ever recreated,
  re-adopt the new key and ID the same way.
- The Chrome Web Store rejects any uploaded manifest that contains a `key`
  field ("key field is not allowed in manifest"), which is why the store, not
  the repo, is the ID authority. `prepareExtensionRelease` strips `key` from
  CI packages automatically; the manual bootstrap zip had it stripped by hand.
- The first manual publish (after review) is still required before API
  publication works.
- The Google Cloud project, the dedicated service account, and the Workload
  Identity provider do not exist yet; the other two GitHub variables are
  produced by those steps. The pipeline uses keyless GitHub OIDC, so no
  long-lived secret is ever stored.
- Until this setup is complete, the release workflows skip the extension
  cleanly (see "Before the store bootstrap" below) and the app hides every
  Browser use surface behind the `BROWSER_USE_ENABLED` feature flag
  (`src/lib/feature-flags.ts` and `src-tauri/src/feature_flags.rs`).
  Flipping those two flags on is part of the launch checklist, after the
  store item is published and the identity variables are set.

## Before the store bootstrap: releases without Web Store identity

Both workflows treat missing `CHROME_WEB_STORE_*` variables as "extension
releases are not enabled yet", never as a failure after the desktop is
already out:

- **RC**: `Submit extension release candidate` still builds and tests the
  extension, then skips every store step with a notice. It also removes any
  stale `extension-build.json` / `June-extension.zip` from the fixed `rc`
  release so the RC promotes desktop-only instead of correlating another
  RC's extension bytes.
- **Stable**: the preflight promotes an RC that carries no extension
  metadata desktop-only, without touching the store. The identity variables
  are required exactly when the promoted RC froze extension work; promoting
  such an RC without them fails before the desktop build starts.
- `Publish reviewed extension to stable` is skipped by design for a
  desktop-only RC, and release bookkeeping still runs.

## One-time Chrome Web Store setup

1. Register the publisher, build the current extension, and upload its bootstrap
   `0.1.0` package once through the Developer Dashboard to create the June item.
   The uploaded manifest must not contain a `key` field (strip it from the
   built `extension/dist/manifest.json` before zipping; the store rejects it).
   Complete the Store listing, Privacy, Distribution, and reviewer instructions,
   then publish that bootstrap once manually. API v2 updates existing items; it
   does not replace this first-item setup. After the upload, adopt the
   store-assigned identity into the repo: paste the generated public key
   (item -> Package tab) into `extension/public/manifest.json` `key` and the
   item ID into `src-tauri/src/extension_host.rs` `EXTENSION_ID`, tests, and
   docs. The pipeline derives its expected ID from the manifest key, so no
   other pipeline configuration changes.
2. Enable two-step verification on the publisher owner account.
3. Enable Chrome Web Store API v2 in a dedicated Google Cloud project.
4. Create one dedicated service account for this release pipeline. Do not create
   a JSON key. Add its email under Chrome Web Store Developer Dashboard ->
   Account -> Service account. Chrome currently permits one service account per
   publisher.
5. Create a GitHub OIDC Workload Identity Pool and Provider. Restrict the
   provider to the `open-software-network/os-june` repository. Because the jobs
   use the `production` GitHub Environment, the expected GitHub subject is:

   ```text
   repo:open-software-network/os-june:environment:production
   ```

6. Grant that federated principal `roles/iam.workloadIdentityUser` on the
   dedicated service account. The service account needs no broad Google Cloud
   project role; Chrome Web Store access comes from registering it with the
   publisher.
7. In the GitHub `production` Environment, configure these non-secret variables:

   | Variable | Value |
   | --- | --- |
   | `CHROME_WEB_STORE_WORKLOAD_IDENTITY_PROVIDER` | Full `projects/.../providers/...` resource name |
   | `CHROME_WEB_STORE_SERVICE_ACCOUNT` | Dedicated service-account email |
   | `CHROME_WEB_STORE_PUBLISHER_ID` | Publisher ID from Developer Dashboard -> Publisher -> Settings |

8. Keep required reviewers enabled on the `production` Environment. The RC and
   stable workflows already use `id-token: write` only in store release jobs.

If the item's visibility changes in the Developer Dashboard, publish once
manually with the new visibility. Chrome does not permit API publication with a
new visibility until that first manual publish succeeds.

## Release flow

### Release an RC

Run `rc-desktop-release` as documented in [release-macos.md](release-macos.md).
After the macOS RC succeeds, `Submit extension release candidate` runs
automatically.

It compares the normalized built-payload fingerprint (with release version
fields removed) with the latest stable `extension-build.json`:

- `unchanged` - no store write or review submission; metadata records that the
  desktop RC continues using the current published extension after live state
  validation;
- `reused-rc` - a later desktop RC has identical extension inputs and reuses the
  current package/submission;
- `changed` - the workflow builds `June-extension.zip`, maps
  `X.Y.Z-rc.N` to store version `(X+1).Y.Z.N`, uploads it, and requests
  `STAGED_PUBLISH` review.

The fixed public `rc` release then contains:

- `rc-build.json` - desktop version and source commit;
- `extension-build.json` - source fingerprint, pinned item ID, store version,
  package SHA-256, and current submission state;
- `June-extension.zip` - present only when this RC has an extension package to
  promote.

Chrome review is asynchronous. A successful RC workflow means the submission is
either `PENDING_REVIEW` or already `STAGED`; it does not bypass review.

### Promote to stable

Run `promote-desktop-release` with the exact RC version. Its first job checks the
Chrome Web Store before starting the costly macOS build:

- unchanged extension inputs must match the expected published version and
  have no uncorrelated active submission;
- changed inputs must match the frozen metadata and ZIP hash, and Chrome must
  report the exact version as `STAGED`;
- pending, rejected, warned, taken-down, missing, or mismatched state fails the
  workflow before desktop publication.

After the desktop release succeeds, `Publish reviewed extension to stable`
calls `DEFAULT_PUBLISH` for the staged submission and verifies the version is
`PUBLISHED`. The stable release in the Releases repo receives the same ZIP and
a stable `extension-build.json`. Unchanged bytes are checked again at this
post-desktop boundary. Homebrew and source-repo version bookkeeping then run in
a separate job, so their failure cannot suppress the correlated extension step.
The desktop release remains a draft until all of its assets verify, and the
signing job freezes their hashes in an immutable Actions artifact before a
separate job can publish it. Publication and Homebrew verify the release bytes
against that artifact, not the release's mutable metadata copy.

## Review timing and recovery

Chrome reviews every submission and review time can range from days to weeks,
especially for sensitive permissions. Enable the publisher's review-complete
email notifications and do not start stable promotion until the submission is
staged.

- **`PENDING_REVIEW`** - wait. The stable preflight is expected to fail.
- **`REJECTED` or `CANCELLED`** - address the dashboard feedback and cut a
  higher desktop RC. The next run rebuilds identical bytes with that higher
  technical store version because terminal versions cannot be reused.
- **Wrong active submission** - the workflow refuses to cancel it. Resolve the
  uncorrelated dashboard state before rerunning.
- **Superseded correlated RC** - a higher RC with changed extension inputs may
  cancel only the exact earlier version named in RC metadata. If a higher RC
  restores the already-published stable bytes, it cancels that same correlated
  active submission before verifying the unchanged published version.
- **`extension-rc` failed before publishing its assets** (extension test or
  build break, store outage mid-submit) - the fixed `rc` release now holds
  the new `rc-build.json` next to the previous RC's `extension-build.json`,
  and stable preflight fails the correlation check for the new RC. Rerun the
  failed job once the cause is fixed. If the break is persistent and the
  desktop must ship, delete both `extension-build.json` and
  `June-extension.zip` from the `rc` release
  (`gh release delete-asset rc <asset> --yes`) to promote desktop-only.
- **Submission succeeded but RC asset upload failed** - rerun the failed job.
  Live state for the current version is treated as non-reusable prior metadata;
  the current package is rebuilt deterministically and submission is idempotent.
- **Staged submission expired** - cut a higher RC and submit again. Deferred
  submissions expire after 30 days.
- **Desktop stable succeeded, extension publish failed** - rerun the failed
  `extension-stable` job. Publishing and metadata upload are idempotent.
- **Desktop publication lost its response** - rerun the failed
  `publish-desktop` job in the original workflow run. It accepts an
  already-public release only when every asset and the public metadata match the
  immutable pre-publication artifact. Do not start a new promotion run.
- **Rerun window** - every "rerun the failed job" recovery depends on the
  run's immutable artifacts, which are retained for 30 days. A failure
  noticed after that cannot be retried through the original run and needs
  manual release surgery; do not let a half-published release sit.
- **Store API says visibility changed** - complete one manual dashboard publish,
  then rerun.

Do not upload a hand-built ZIP or edit `extension-build.json`. The source
fingerprint, store version, and package hash are the correlation proof used by
stable promotion.

## Local package verification

The release workflow runs the same extension checks before packaging:

```sh
pnpm --filter june-extension typecheck
pnpm --filter june-extension test
pnpm extension:build
```

For interactive behavior, load `extension/dist` unpacked and follow the Browser
use QA instructions. Store publication itself is intentionally CI-only.
