# Releasing OS Scribe for macOS

End-to-end runbook for cutting a signed, notarized `.app` + `.dmg` that
end users can download, drag to `/Applications`, and launch without
Gatekeeper warnings. Covers the nested helper apps (Swift sources at
`src-tauri/native/mac-system-audio-recorder` and `mac-dictation-helper`,
bundled into the distribution as `OS Scribe.app` and `OS Scribe
Dictation Helper.app`) and the `osscribe://` URL scheme registration.

If something here is wrong or missing, fix it in the same PR as the
release — runbooks rot if they're not maintained against reality.

## Prerequisites (one-time setup)

### 1. Apple Developer Program enrollment

- Active **Apple Developer Program** account ($99/year, organization tier
  recommended for shared signing across team members).
- Note your **Team ID** (10-character alphanumeric) from
  https://developer.apple.com/account → Membership.

### 2. Developer ID Application certificate

For distribution *outside* the Mac App Store (DMG download), you need a
**Developer ID Application** certificate. Not the same as "Apple
Distribution" (App Store only) or "Apple Development" (local builds only).

Create via Xcode (preferred) or Apple Developer portal:

```
Xcode → Settings → Accounts → your Apple ID → Manage Certificates →
"+" → "Developer ID Application"
```

Export it to `.p12` for use in CI:

```
Keychain Access → login keychain → Certificates → right-click the
Developer ID Application cert → Export → Personal Information
Exchange (.p12) → set a strong password.
```

The `.p12` password becomes `APPLE_CERTIFICATE_PASSWORD` in env.

### 3. App-specific password for notarization

Apple requires a separate password for `notarytool`:

1. https://appleid.apple.com → Sign-In and Security → App-Specific
   Passwords → Generate (label it "OS Scribe notarization").
2. Save the password — you only see it once.

This becomes `APPLE_PASSWORD` in env. **Do not** use your Apple ID
account password.

### 4. Environment variables

Set these in your shell (or CI secrets) before any signed build:

```sh
# Identity: the common name of your Developer ID Application cert.
# Find with: security find-identity -v -p codesigning
export APPLE_SIGNING_IDENTITY="Developer ID Application: Open Software Network (XXXXXXXXXX)"

# Notarization credentials.
export APPLE_ID="ops@opensoftware.network"
export APPLE_PASSWORD="<app-specific password from step 3>"
export APPLE_TEAM_ID="XXXXXXXXXX"

# Optional: if signing in CI (no keychain available), provide the
# certificate as base64. Tauri imports it into a temporary keychain.
# Convert with: base64 -i Certificate.p12 | pbcopy
# export APPLE_CERTIFICATE="<base64 .p12 contents>"
# export APPLE_CERTIFICATE_PASSWORD="<the .p12 password from step 2>"
```

Tauri's `tauri build` reads these env vars and signs + notarizes
automatically when present. No tauri.conf.json change needed.

## Per-release checklist

### 1. Confirm clean main + green CI

```sh
git checkout main
git pull
git status                                # working tree must be clean
gh run list --workflow=build-scribe-api --limit 3   # recent ci green
```

### 2. Bump versions in three places

Tauri reads three separate version fields; keep them aligned to avoid
about-page / bundle-version mismatches.

```sh
# Pick a version per semver. Examples below use 0.2.0.
VERSION="0.2.0"

# 1/3 — frontend / Tauri config (drives Info.plist CFBundleShortVersionString).
# Edit src-tauri/tauri.conf.json: "version": "0.2.0"

# 2/3 — Rust crate (drives the binary).
# Edit src-tauri/Cargo.toml: version = "0.2.0"

# 3/3 — npm package (cosmetic but kept in sync).
# Edit package.json: "version": "0.2.0"
```

No manual `cargo update` needed — `pnpm tauri:build` invokes `cargo
build`, which refreshes `Cargo.lock` only when the version bump
requires it. Running `cargo update -p os-scribe` here would pull
newer compatible patch versions of dependencies as a side effect,
which is the wrong thing to do mid-release.

### 3. Update CHANGELOG (if you keep one)

Convention: append a `## v0.2.0 — YYYY-MM-DD` section. Skip if no
CHANGELOG exists; the git log + PR titles are the source of truth.

### 4. Verify clean local checks pass

```sh
pnpm lint                                 # tsc --noEmit
pnpm test                                 # vitest
pnpm test:rust                            # cargo test (--lib + integration)
```

Don't skip — `pnpm tauri:build` will still produce a binary even with
broken types or failing tests; you want both gates here.

### 5. Build the signed + notarized bundle

```sh
# Source the env from step 4 of Prerequisites first, then:
pnpm tauri:build
```

This runs `tauri build --bundles app,dmg` (already configured in
`package.json`). With the env vars set:

1. `cargo build --release` compiles the Rust binary.
2. `build.rs` builds the Swift helper apps from
   `src-tauri/native/mac-system-audio-recorder` and `mac-dictation-helper`
   into `.tauri-helper/OS Scribe.app` and `.tauri-helper/OS Scribe
   Dictation Helper.app` (the `.app` names — not the source dir names —
   are what land in the final bundle).
3. Tauri bundles `OS Scribe.app` with both helper `.app`s nested in
   `Contents/Resources/native/bin/`.
4. **Code signing** runs `codesign --deep --options runtime` across the
   bundle, signing nested executables first, then the outer app.
5. **Notarization** uploads the signed bundle to Apple via
   `notarytool submit --wait`. Returns when Apple's automated scan
   completes (5–15 minutes typically).
6. **Stapling** attaches the notarization ticket to the bundle so it
   verifies offline.
7. The DMG is built around the stapled `.app` and stapled separately.

Output (the DMG filename embeds the version + host architecture —
`aarch64` on Apple Silicon, `x86_64` on Intel — so the exact name
varies):

```
src-tauri/target/release/bundle/macos/OS Scribe.app
src-tauri/target/release/bundle/dmg/OS Scribe_${VERSION}_<arch>.dmg
```

### 6. Verify the build before distributing

These checks catch ~95% of "user sees Gatekeeper warning" issues:

```sh
ARCH=$(uname -m | sed 's/arm64/aarch64/')   # arm64 → aarch64, x86_64 stays
APP="src-tauri/target/release/bundle/macos/OS Scribe.app"
DMG="src-tauri/target/release/bundle/dmg/OS Scribe_${VERSION}_${ARCH}.dmg"

# 1. Signature is intact and matches your Developer ID.
codesign --verify --deep --strict --verbose=2 "$APP"

# 2. Gatekeeper will accept it (Apple's actual install-time check).
spctl --assess --type execute --verbose "$APP"
spctl --assess --type install --verbose "$DMG"

# 3. Notarization ticket is stapled (works offline).
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

# 4. The deep-link URL scheme is registered in Info.plist.
plutil -extract CFBundleURLTypes xml1 -o - "$APP/Contents/Info.plist"
# Expect to see <string>osscribe</string> inside CFBundleURLSchemes.

# 5. Entitlements are what you expect (especially helpers).
codesign -d --entitlements :- "$APP"
```

If any check fails, **do not distribute**. Common fixes in the
Troubleshooting section below.

### 7. Smoke-test the DMG manually

Drag the `.app` out of the DMG into `/Applications` (don't double-launch
from the DMG; that's not how end users will run it). Then:

```sh
# Force Launch Services to re-index — useful if you're testing
# multiple builds in a row and want a fresh URL-handler registration.
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
  -R -f /Applications/OS\ Scribe.app

# Confirm the URL handler is registered.
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
  -dump | grep -i osscribe
```

You should see your bundle ID claiming the `osscribe` scheme.

Then in a browser address bar:

```
osscribe://auth/callback?code=test&state=test
```

macOS should prompt "Open in OS Scribe?" the first time, then forward
the URL to the running app. If the app is closed, it should launch and
receive the URL. Either way, the auth flow should resolve (or fail
gracefully with `state_mismatch` since this is a synthetic URL).

### 8. Tag and publish

```sh
git tag -a "v$VERSION" -m "release: v$VERSION"
git push origin "v$VERSION"

# Create a GitHub release with the DMG attached.
gh release create "v$VERSION" \
  "$DMG" \
  --title "OS Scribe v$VERSION" \
  --notes-file RELEASE-NOTES.md   # or --generate-notes
```

### 9. Update the install link on the marketing site / README

Point any "Download for macOS" link at the new release's DMG asset URL:

```
https://github.com/open-software-network/os-scribe/releases/download/v$VERSION/OS%20Scribe_${VERSION}_aarch64.dmg
```

## How URL scheme registration actually works

You don't register `osscribe://` "during installation" in any active
sense — there's no install script. Instead:

1. `tauri-plugin-deep-link`'s config in `tauri.conf.json` causes
   `tauri build` to inject `CFBundleURLTypes` into `Info.plist` at
   build time.
2. When the user drags the `.app` to `/Applications` (or anywhere else),
   macOS's **Launch Services** indexes the bundle. The first index can
   happen as early as the user hovering the `.app` in Finder; it
   definitely happens on first launch.
3. Launch Services reads `CFBundleURLTypes` and registers the bundle as
   the handler for `osscribe://`.
4. Any subsequent `osscribe://...` URL — whether clicked in a browser,
   typed in Spotlight, or `open`ed from Terminal — routes to your app.
5. If two apps register the same scheme, the most recently launched
   wins. Not a concern for `osscribe://` (it's specific to us).

So the installer responsibility is: **produce a valid `.app` with the
right `Info.plist`, and trust Launch Services to do the rest.** The
verification commands in step 6 + step 7 confirm this worked.

### Updating an existing install

If a user already has v0.1.0 installed and you ship v0.2.0 with the
URL scheme added, dragging the new `.app` over the old one in
`/Applications` doesn't always trigger Launch Services to re-index. Two
mitigations:

- **First-launch fix**: every macOS user opens the app at least once
  after upgrading. That always triggers re-indexing.
- **Force re-index**: if you need it sooner (e.g., the auth flow runs
  before first interactive launch in some scenarios), tell users to
  run the `lsregister -R -f /Applications/OS\ Scribe.app` command from
  step 7. We don't bake this into an installer because there's no
  installer — it's a manual drag.

## Distribution channels

| Channel | What to ship | Notes |
|---|---|---|
| GitHub Releases (recommended) | the `.dmg` from step 5 | Free, versioned, signed URL. |
| Marketing site direct download | a pinned link to the GH release asset | Re-point on each release. Don't host the DMG yourself unless you need to control bandwidth — Cloudflare in front of GH releases is usually fine. |
| Homebrew Cask | a cask formula pointing at the GH release | Optional. Adds discoverability. Casks require notarized DMGs (we have that). |
| Mac App Store | **not from this runbook** | Different cert (Apple Distribution), sandbox tighter, custom URL schemes are second-class. Not recommended for this app. |

## Troubleshooting

### "Could not be verified" / "damaged" Gatekeeper warning

- **Cause**: not notarized, not stapled, or signed with the wrong cert.
- **Check**: `spctl --assess --type install --verbose "$DMG"`. The
  output should include `accepted` and `source=Notarized Developer ID`.
- **Fix**: re-run `pnpm tauri:build` with the right env vars; confirm
  `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` are set.

### Notarization fails with "binary not signed with hardened runtime"

- **Cause**: a nested helper binary wasn't signed with `--options runtime`.
- **Check**: `codesign -d --verbose=4 "$APP/Contents/Resources/native/bin/OS Scribe.app/Contents/MacOS/<helper>"`.
  Look for `flags=0x10000(runtime)`.
- **Fix**: usually a Tauri / build.rs issue. The `--deep` codesign pass
  should handle it; if it didn't, manually sign the helper first:
  ```sh
  codesign --force --options runtime --sign "$APPLE_SIGNING_IDENTITY" \
    "$APP/Contents/Resources/native/bin/OS Scribe.app/Contents/MacOS/<helper>"
  ```

### URL scheme not firing after install

- **First check**: `lsregister -dump | grep osscribe`. If your bundle
  ID isn't listed, Launch Services didn't index. Run the force
  re-index from step 7.
- **Second check**: `plutil -extract CFBundleURLTypes xml1 -o - "$APP/Contents/Info.plist"`.
  If empty, the deep-link plugin didn't inject the entry — confirm
  `tauri.conf.json` has a `plugins.deep-link` block and rebuild.
  Note: tauri-plugin-deep-link reads the `mobile` array (not
  `desktop`) to drive macOS `CFBundleURLTypes` injection at build
  time — the `desktop` block is for the runtime scheme registration
  on Windows/Linux. Both should be set; the macOS build step only
  cares about `mobile`.

### Sandbox blocks something at runtime

Current `Entitlements.plist` has `com.apple.security.app-sandbox =
true` plus audio-input and a read-write toggle. URL scheme handling
works inside the sandbox. If a future feature needs another capability
(file picker, network listener, etc.), add the entitlement to
`Entitlements.plist` *before* signing — sandbox is enforced at runtime
based on what's signed in, not what's in the source file at runtime.

### Helper app loses Accessibility permission after update

macOS treats each codesigned binary as a separate identity. If you
re-sign a helper app with a different cert (e.g., during a team transfer),
the user's previously-granted Accessibility permission is revoked and
must be re-granted in System Settings → Privacy & Security → Accessibility.
Reset for testing with:

```sh
# The dictation helper is the bundle that actually requests
# Accessibility (it posts the paste shortcut into the focused app),
# so reset its bundle id — not the main app's.
tccutil reset Accessibility co.opensoftware.scribe.dictation-helper
```

## CI automation (future work — not in scope yet)

A `release-macos.yml` GitHub Actions workflow could run the steps
above unattended on every tag push. Requires:

- `APPLE_CERTIFICATE` (base64), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`,
  `APPLE_SIGNING_IDENTITY` bound as repo secrets.
- A `macos-14` runner (Apple Silicon).
- `tauri-action@v0` does the sign + notarize + release-attach in one
  step. Worth the ~15min build time once you do >1 release per month.

Open an issue when this gets prioritized.
