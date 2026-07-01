# Releasing June for Windows

June ships Windows builds as an NSIS installer. The production Windows release
workflow builds from `main`, signs the app executable and installer with
Authenticode, signs updater artifacts with the Tauri updater key, and attaches
Windows assets to the existing `open-software-network/os-june-releases` release.

## Windows support

The Windows installer supports the app shell, OS Accounts sign-in, microphone
recording, note generation, folders, and settings backed by the production June
API. Global dictation shortcuts, dictation paste, macOS system-audio capture, and
Seatbelt sandbox features are macOS-only.

Production Windows builds bundle the pinned Hermes runtime under `native/hermes`,
so June can start the agent on a clean machine without Python, GitHub downloads,
or a first-run runtime install. Agent and routines workflows still run without
the macOS Seatbelt write-jail until Windows has its own isolation layer.

## One-time prerequisites

Create or confirm these before cutting the first Windows release:

- Public GitHub repo: `open-software-network/os-june-releases`.
- Release GitHub App installed on `os-june` and `os-june-releases` with
  `contents:write`, exposed as `RELEASE_APP_ID` and
  `RELEASE_APP_PRIVATE_KEY`.
- Authenticode signing certificate exported as a password-protected PFX. Store
  the base64-encoded PFX in `WINDOWS_CERTIFICATE` and its password in
  `WINDOWS_CERTIFICATE_PASSWORD`.
- Optional `WINDOWS_SIGNING_TIMESTAMP_URL` if the default
  `http://timestamp.digicert.com` should be overridden.
- Optional `WINDOWS_SIGNTOOL_PATH` if the runner cannot discover
  `signtool.exe` from `PATH` or the Windows SDK.
- Updater signing secrets: `TAURI_SIGNING_PRIVATE_KEY` and, when the key is
  password-protected, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Production runtime secrets: `PRODUCTION_OS_ACCOUNTS_URL`,
  `PRODUCTION_OS_ACCOUNTS_API_URL`, `PRODUCTION_OS_ACCOUNTS_CLIENT_ID`, and
  `PRODUCTION_JUNE_API_URL`.

Keep the Authenticode certificate separate from the Tauri updater key. The
certificate establishes the Windows publisher signature. The updater key signs
the update artifact that Tauri verifies before installation.

## Cutting a production Windows release

Cut the macOS release first (build an RC, then promote it):

```text
GitHub Actions -> rc-desktop-release -> Run workflow (base-version X.Y.Z, rc-number N)
GitHub Actions -> promote-desktop-release -> Run workflow (rc-version X.Y.Z-rc.N)
```

Promote owns the clean semver `X.Y.Z`, the `release: vX.Y.Z` bump committed
directly to `main` by the release bot, the stable release creation, macOS assets,
and initial `latest.json`. It also records the source commit in a
`stable-build.json` asset on the `vX.Y.Z` release. The Windows workflow reads that
commit and rebuilds the same tree, so it does not depend on the bump and can run
as soon as promote finishes.

Once promote has published `vX.Y.Z`, run:

```text
GitHub Actions -> production-desktop-windows -> Run workflow -> version X.Y.Z
```

The Windows workflow performs the release steps in order:

1. Reads `stable-build.json` from the `vX.Y.Z` release to learn the promoted
   source commit, then checks that commit out (not `main`).
2. Validates required Windows signing, updater, release, and production runtime
   secrets.
3. Stamps the clean `X.Y.Z` version into the checked-out tree so the Windows
   build matches the promoted macOS version.
4. Verifies release `vX.Y.Z` and its existing `latest.json` exist in
   `open-software-network/os-june-releases`.
5. Runs `pnpm typecheck` and `pnpm test`.
6. Builds the bundled Hermes runtime with
   `scripts/bundle-hermes-runtime-windows.ps1`: the pinned hermes-agent
   checkout, a relocatable CPython, Python deps, prebuilt dashboard UI, and a
   relocatable `bin/hermes.exe` launcher.
7. Authenticode-signs the bundled Hermes `.exe`, `.dll`, and `.pyd` binaries.
8. Builds the Windows NSIS installer with production OS Accounts and June API
   configuration embedded as fallback runtime config.
9. Signs the app executable and NSIS installer through
   `scripts/windows-sign.ps1`.
10. Verifies Authenticode status for the executable and installer, checks the
    updater signature file exists, and inspects the NSIS payload, including the
    bundled Hermes launcher and Python runtime.
11. Uploads the NSIS output as a workflow artifact.
12. Uploads Windows release assets and merges `windows-x86_64` into
    `latest.json` without removing macOS updater entries or the generated
    release changelog.

## Validation

After the workflow publishes assets, download `June_x64-setup.exe` from
`open-software-network/os-june-releases`, copy it to a clean Windows 11 VM, and
run:

```powershell
$installer = "$env:USERPROFILE\Downloads\June_x64-setup.exe"
Get-AuthenticodeSignature $installer | Format-List
Start-Process -FilePath $installer -ArgumentList "/S" -Wait
Start-Process "$env:LOCALAPPDATA\June\June.exe"
```

Confirm the signature status is `Valid`, the publisher is Open Software Network,
the app launches as June, the sign-in copy mentions recording and notes without
dictation, and the bundled agent starts on a clean VM with no Python installed.
Record from the microphone and generate a note against production June API
before linking the installer publicly.

For updater validation after a second Windows release, install an older
updater-capable Windows build, run **June -> Check for updates...**, confirm the
prompt shows the new version, install, and verify the app exits for the Windows
installer handoff and relaunches cleanly on the new version.

If Authenticode validation, updater signature validation, sign-in, recording, or
update installation fails, do not promote the Windows installer.
