# Releasing June for macOS

June ships signed, notarized macOS builds with in-app auto-updates through
`tauri-plugin-updater`. The source repo stays private; update artifacts,
signatures, the DMG, and `latest.json` are published to the public
`open-software-network/os-june-releases` repo.

## macOS support

June supports macOS 14.0 and later on Apple Silicon and Intel Macs, including
macOS 15. Production and staging builds ship as universal macOS apps. System
audio capture uses Core Audio process taps and is available only on macOS 14.2
and later. On macOS 14.0 or 14.1, recording falls back to microphone-only mode.

The first updater-capable build must be installed manually once — earlier builds
ship without the updater, so they can't pull it in — and every release after that
updates in place. Choose the release version per semver when you run the release
workflow; don't hard-code a specific number in this runbook.

## One-time prerequisites

Create or confirm these before cutting the first updater release:

- Public GitHub repo: `open-software-network/os-june-releases`.
- Release GitHub App (org-owned) installed on the public releases repo with
  `contents:write`, exposed as `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`.
  The workflow mints a short-lived, repo-scoped token from it at run time
  (replaces the old `RELEASES_REPO_TOKEN` PAT). The same App can later be added
  as a ruleset bypass actor when `main` is protected.
- Apple signing secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`.
- Apple notarization API secrets: `APPLE_API_ISSUER`, `APPLE_API_KEY`,
  `APPLE_API_KEY_P8`.
- Updater signing secrets: `TAURI_SIGNING_PRIVATE_KEY` and, when the key is
  password-protected, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Production runtime secrets: `PRODUCTION_OS_ACCOUNTS_URL`,
  `PRODUCTION_OS_ACCOUNTS_API_URL`, `PRODUCTION_OS_ACCOUNTS_CLIENT_ID`, and
  `PRODUCTION_JUNE_API_URL`.

The updater keypair is separate from the Apple Developer ID certificate. The
public key is embedded in `src-tauri/tauri.conf.json`; the private key must live
only in CI secrets and the team password manager. Losing the private key
permanently breaks auto-update for all builds signed with its public key.

Generate a keypair with:

```sh
pnpm tauri signer generate --write-keys keys/os-june-updater.key
```

Do not commit `keys/`. Copy the private key contents into
`TAURI_SIGNING_PRIVATE_KEY`, copy the password into
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if one was used, back both up, and embed
the `.pub` contents as the updater `pubkey`.

## Cutting a production release

Releases go through the release-candidate channel: build an RC, test it via the
in-app updater, then promote it to stable. There is no direct stable-build path.

### 1. Build a release candidate

```text
GitHub Actions -> rc-desktop-release -> Run workflow
  base-version = X.Y.Z   (the version you are heading toward)
  rc-number    = 1        (2, 3, ... for later candidates)
```

`rc-desktop-release` builds a signed + notarized `universal-apple-darwin` app at
version `X.Y.Z-rc.N` (bundling the Hermes runtime), and publishes it to a fixed
`rc` prerelease in `open-software-network/os-june-releases` with `latest-rc.json`.
It records the source commit in `rc-build.json` (so promote can rebuild the same
tree) and does NOT touch `main`.

### 2. Test the candidate

In the app: Settings -> About -> Release channel -> Release candidate, then check
for updates. The app follows `latest-rc.json` and installs the RC. Iterate with a
higher `rc-number` until it is good.

### 3. Promote to stable

```text
GitHub Actions -> promote-desktop-release -> Run workflow
  rc-version = (blank, or X.Y.Z-rc.N to guard against promoting the wrong one)
```

`promote-desktop-release` checks out the exact commit the RC was built from,
stamps the clean `X.Y.Z`, and reruns the full sign + notarize path, so stable
ships the same source you tested with a clean version string. It then:

- publishes the `vX.Y.Z` stable release (marked latest) with the DMG, updater
  archive + signature, and a regenerated `latest.json`;
- generates the changelog (first-parent commits since the previous `release: v...`)
  and embeds it in both the GitHub release notes and `latest.json`;
- opens a `release: vX.Y.Z` PR bumping the version files on `main`.

### 4. Merge the version PR

Merge the `release: vX.Y.Z` PR so `main`'s version files advance and the next
changelog can anchor on it. This is required before cutting the Windows release.

The app polls:

```text
https://github.com/open-software-network/os-june-releases/releases/latest/download/latest.json
```

That endpoint is baked into shipped builds. Keep it alive until every install
that points at it has aged out or updated.

## Local fallback build

`scripts/build-signed-dmg.sh` remains as a fallback until a CI-built,
updater-delivered build passes Gatekeeper assessment and relaunches cleanly.
Use it only if the `tauri-action` path is blocked:

```sh
pnpm tauri:build:signed-dmg
```

Do not delete the fallback script until the first production updater release has
been installed over a previous updater-capable build and relaunched successfully.

## First updater release validation

After the workflow publishes a release, download the DMG from
`open-software-network/os-june-releases`, install the app into
`/Applications`, and run:

```sh
APP="/Applications/June.app"
DMG="$HOME/Downloads/June_universal.dmg"

codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose "$APP"
spctl --assess --type install --verbose "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
plutil -extract CFBundleURLTypes xml1 -o - "$APP/Contents/Info.plist"
lipo -archs "$APP/Contents/MacOS/os-june"
lipo -archs "$APP/Contents/Resources/native/bin/June Dictation Helper.app/Contents/MacOS/june-dictation-helper"
lipo -archs "$APP/Contents/Resources/native/bin/June.app/Contents/MacOS/june-system-audio-recorder"
```

Confirm `osjune` appears in `CFBundleURLSchemes` and each `lipo` command
prints both `x86_64` and `arm64`.

For the first updater-to-updater validation, install an older updater-capable
build, run **June -> Check for updates…**, confirm the prompt shows the
new version and release notes, install, and verify the app relaunches without
Gatekeeper warnings. Also confirm microphone and Accessibility permissions are
still granted after relaunch.

If any signing, notarization, updater signature, Gatekeeper, or relaunch check
fails, do not promote the release. Keep the fallback build path until the CI
path is proven with a real updater-delivered relaunch.
