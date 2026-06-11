# Releasing June for macOS

June ships signed, notarized macOS builds with in-app auto-updates through
`tauri-plugin-updater`. The source repo stays private; update artifacts,
signatures, the DMG, and `latest.json` are published to the public
`open-software-network/os-scribe-releases` repo.

The first updater-capable build must be installed manually once — earlier builds
ship without the updater, so they can't pull it in — and every release after that
updates in place. Choose the release version per semver when you run the release
workflow; don't hard-code a specific number in this runbook.

## One-time prerequisites

Create or confirm these before cutting the first updater release:

- Public GitHub repo: `open-software-network/os-scribe-releases`.
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
  `PRODUCTION_SCRIBE_API_URL`.

The updater keypair is separate from the Apple Developer ID certificate. The
public key is embedded in `src-tauri/tauri.conf.json`; the private key must live
only in CI secrets and the team password manager. Losing the private key
permanently breaks auto-update for all builds signed with its public key.

Generate a keypair with:

```sh
pnpm tauri signer generate --write-keys keys/os-scribe-updater.key
```

Do not commit `keys/`. Copy the private key contents into
`TAURI_SIGNING_PRIVATE_KEY`, copy the password into
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if one was used, back both up, and embed
the `.pub` contents as the updater `pubkey`.

## Cutting a production release

Use the manual workflow:

```text
GitHub Actions -> production-desktop-release -> Run workflow -> version X.Y.Z
```

The workflow performs the release steps in order:

1. Checks out `main`.
2. Validates required secrets.
3. Validates the requested version is plain semver and greater than the current
   version.
4. Bumps `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and
   `package.json`, refreshes `src-tauri/Cargo.lock`, commits
   `release: vX.Y.Z`, and pushes to `main`.
5. Runs `pnpm lint`, `pnpm test`, and `pnpm test:rust`.
6. Builds the bundled Hermes runtime (`scripts/bundle-hermes-runtime.sh`):
   the pinned hermes-agent checkout, a relocatable CPython, hash-verified
   Python deps, and the prebuilt dashboard UI, signed Mach-O by Mach-O and
   shipped under `Resources/native/hermes` so first launch needs no network
   install. Adds roughly 110 MB compressed to the DMG.
7. Builds the `aarch64-apple-darwin` app and DMG with `tauri-action`.
8. Signs with the Apple Developer ID cert, notarizes with Apple API key
   credentials, signs updater artifacts with the Ed25519 updater key, and
   publishes the release assets plus `latest.json` to
   `open-software-network/os-scribe-releases`.

The app polls:

```text
https://github.com/open-software-network/os-scribe-releases/releases/latest/download/latest.json
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
`open-software-network/os-scribe-releases`, install the app into
`/Applications`, and run:

```sh
VERSION="0.2.0"
APP="/Applications/June.app"
DMG="$HOME/Downloads/June_${VERSION}_aarch64.dmg"

codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose "$APP"
spctl --assess --type install --verbose "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
plutil -extract CFBundleURLTypes xml1 -o - "$APP/Contents/Info.plist"
```

Confirm `osscribe` appears in `CFBundleURLSchemes`.

For the first updater-to-updater validation, install an older updater-capable
build, run **June -> Check for updates…**, confirm the prompt shows the
new version and release notes, install, and verify the app relaunches without
Gatekeeper warnings. Also confirm microphone and Accessibility permissions are
still granted after relaunch.

If any signing, notarization, updater signature, Gatekeeper, or relaunch check
fails, do not promote the release. Keep the fallback build path until the CI
path is proven with a real updater-delivered relaunch.
