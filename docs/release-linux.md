# Releasing June for Linux

June ships Linux builds as an AppImage and a deb package. The production Linux
release workflow builds from the same source commit the macOS release was
promoted from, signs the AppImage updater artifact with the Tauri updater key,
and attaches Linux assets to the existing
`open-software-network/os-june-releases` release.

Linux has no OS code signing. The app payload carries no publisher signature,
unlike the macOS Developer ID signature or the optional Windows Authenticode
signature. The Tauri updater key still signs the AppImage updater artifact, and
that key is required for every Linux release.

## Linux support

The Linux build supports the app shell, OS Accounts sign-in, microphone
recording, note generation, folders, and settings backed by the production June
API. System audio capture, dictation, dictation paste, meeting detection, and
the macOS Seatbelt write-jail are macOS-only today.

Production Linux builds bundle the pinned Hermes runtime under `native/hermes`,
so June can start the agent on a clean machine without Python, GitHub downloads,
or a first-run runtime install. Agent and routines workflows still run without
the macOS Seatbelt write-jail until Linux has its own isolation layer.

Only the AppImage auto-updates. The Tauri updater on Linux supports AppImage
only, so the deb package does not update itself. Users on the deb package
upgrade by installing a newer deb.

## One-time prerequisites

Create or confirm these before cutting the first Linux release:

- Public GitHub repo: `open-software-network/os-june-releases`.
- Release GitHub App installed on `os-june` and `os-june-releases` with
  `contents:write`, exposed as `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`.
- Updater signing secrets: `TAURI_SIGNING_PRIVATE_KEY` and, when the key is
  password-protected, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. This is the same
  updater key the macOS and Windows releases use.
- Production runtime secrets: `PRODUCTION_OS_ACCOUNTS_URL`,
  `PRODUCTION_OS_ACCOUNTS_API_URL`, `PRODUCTION_OS_ACCOUNTS_CLIENT_ID`, and
  `PRODUCTION_JUNE_API_URL`.

There is no Linux signing certificate to manage. The updater key signs the
update artifact that Tauri verifies before installation.

## Cutting a production Linux release

Cut the macOS release first (build an RC, then promote it):

```text
GitHub Actions -> rc-desktop-release -> Run workflow (base-version X.Y.Z, rc-number N)
GitHub Actions -> promote-desktop-release -> Run workflow (rc-version X.Y.Z-rc.N)
```

Promote owns the clean semver `X.Y.Z`, the stable release, macOS assets, and the
initial `latest.json`. It records the source commit in a `stable-build.json`
asset on the `vX.Y.Z` release. The Linux workflow reads that commit and rebuilds
the same tree, so it can run as soon as promote finishes and does not depend on
`main` advancing.

Once promote has published `vX.Y.Z`, run:

```text
GitHub Actions -> production-desktop-linux -> Run workflow -> version X.Y.Z
```

The Linux workflow performs the release steps in order:

1. Reads `stable-build.json` from the `vX.Y.Z` release to learn the promoted
   source commit, then checks that commit out (not `main`).
2. Validates required updater, release, and production runtime secrets.
3. Installs the Linux desktop build dependencies and uv.
4. Stamps the clean `X.Y.Z` version into the checked-out tree so the Linux build
   matches the promoted macOS version.
5. Verifies release `vX.Y.Z` and its existing `latest.json` exist in
   `open-software-network/os-june-releases`.
6. Runs `pnpm typecheck` and `pnpm test`.
7. Builds the bundled Hermes runtime with
   `scripts/bundle-hermes-runtime-linux.sh`: the pinned hermes-agent checkout, a
   relocatable CPython, Python deps, prebuilt dashboard UI, and a relocatable
   `bin/hermes` launcher.
8. Builds the Linux AppImage and deb with production OS Accounts and June API
   configuration embedded as fallback runtime config, signing the AppImage
   updater artifact with the Tauri updater key.
9. Verifies the AppImage, its updater signature, and the deb exist, and inspects
   both payloads for the bundled Hermes launcher and Python runtime.
10. Uploads the AppImage and deb as a workflow artifact.
11. Uploads Linux release assets (versioned AppImage, deb, updater signature,
    and the `June_amd64.AppImage` and `June_amd64.deb` stable aliases) and merges
    `linux-x86_64` into `latest.json` without removing the macOS or Windows
    updater entries or the generated release changelog.

## Validation

After the workflow publishes assets, download `June_amd64.AppImage` from
`open-software-network/os-june-releases`, copy it to a clean Linux desktop (a
distro without June, Python, or the June build dependencies), and run it:

```sh
chmod +x ~/Downloads/June_amd64.AppImage
~/Downloads/June_amd64.AppImage
```

Confirm the app launches as June, the tray icon appears, the sign-in copy
mentions recording and notes without dictation, and the bundled agent starts on
a clean machine with no Python installed. Sign in through OS Accounts, record
from the microphone, and generate a note against the production June API before
linking the AppImage publicly. Do not expect system audio, dictation, or meeting
detection: those are macOS-only today.

Also install the deb on a clean Debian or Ubuntu machine to confirm the package
installs, launches, and starts the bundled agent:

```sh
sudo apt install ~/Downloads/June_amd64.deb
```

Then launch June from the applications menu.

For updater validation after a second Linux release, install an older
AppImage build, run **June -> Check for updates...**, confirm the prompt shows
the new version, install, and verify the app relaunches cleanly on the new
version. The deb package does not auto-update, so validate deb upgrades by
installing the newer deb by hand.

If sign-in, tray, microphone recording, note generation, or AppImage update
installation fails, do not link the Linux assets publicly.
