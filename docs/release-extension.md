# Releasing the June browser extension

The June Chrome extension is released as part of the desktop RC-to-stable flow.
The RC workflow submits changed extension bytes for Chrome review with deferred
publication. Stable desktop promotion is blocked until Chrome approves that
exact package, then publishes it after the desktop release succeeds.

The architecture and trade-offs are recorded in [ADR 0025](adr/0025-extension-releases-follow-desktop-rc-promotion.md).

## One-time Chrome Web Store setup

1. Register the publisher, build the current extension, and upload its bootstrap
   `0.1.0` package once through the Developer Dashboard to create the June item.
   Complete the Store listing, Privacy, Distribution, and reviewer instructions,
   then publish that bootstrap once manually. API v2 updates existing items; it
   does not replace this first-item setup. The resulting item ID must be
   `adckhkfngpnenaapncoipkalcfpjbgcn`, derived from the pinned `key` in
   `extension/public/manifest.json`.
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

- `unchanged` - no store call; metadata records that the desktop RC continues
  using the current published extension;
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

- unchanged extension inputs pass immediately;
- changed inputs must match the frozen metadata and ZIP hash, and Chrome must
  report the exact version as `STAGED`;
- pending, rejected, warned, taken-down, missing, or mismatched state fails the
  workflow before desktop publication.

After the desktop release succeeds, `Publish reviewed extension to stable`
calls `DEFAULT_PUBLISH` for the staged submission and verifies the version is
`PUBLISHED`. The stable GitHub release receives the same ZIP and a stable
`extension-build.json`.

## Review timing and recovery

Chrome reviews every submission and review time can range from days to weeks,
especially for sensitive permissions. Enable the publisher's review-complete
email notifications and do not start stable promotion until the submission is
staged.

- **`PENDING_REVIEW`** - wait. The stable preflight is expected to fail.
- **`REJECTED`** - address the dashboard feedback and cut a higher desktop RC.
  Chrome versions cannot be reused.
- **Wrong active submission** - the workflow refuses to cancel it. Resolve the
  uncorrelated dashboard state before rerunning.
- **Superseded correlated RC** - a higher RC with changed extension inputs may
  cancel only the exact earlier version named in RC metadata.
- **Staged submission expired** - cut a higher RC and submit again. Deferred
  submissions expire after 30 days.
- **Desktop stable succeeded, extension publish failed** - rerun the failed
  `extension-stable` job. Publishing and metadata upload are idempotent.
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
