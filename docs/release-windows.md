# Releasing June for Windows

June ships Windows builds as an NSIS installer. The production Windows release
workflow builds from `main`, signs updater artifacts with the Tauri updater key,
signs the app executable and installer with Authenticode when certificate
secrets are configured, and attaches Windows assets to the existing
`open-software-network/os-june-releases` release.

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
- Optional Authenticode signing certificate exported as a password-protected
  PFX. Store the base64-encoded PFX in `WINDOWS_CERTIFICATE` and its password in
  `WINDOWS_CERTIFICATE_PASSWORD`. If both are absent, the workflow publishes an
  unsigned NSIS installer and records a warning in the run summary.
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
certificate establishes the Windows publisher signature when configured. The
updater key signs the update artifact that Tauri verifies before installation
and is required for every Windows release.

## Cutting a production Windows release

Run the macOS production release first:

```text
GitHub Actions -> production-desktop-release -> Run workflow -> version X.Y.Z
```

That workflow owns the semver bump, `main` push, release creation, macOS assets,
and initial `latest.json`.

After it succeeds, run:

```text
GitHub Actions -> production-desktop-windows -> Run workflow -> version X.Y.Z
```

The Windows workflow performs the release steps in order:

1. Checks out `main`.
2. Validates required updater, release, and production runtime secrets, then
   detects whether Authenticode signing is configured.
3. Verifies `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml` already match the requested version.
4. Verifies release `vX.Y.Z` and its existing `latest.json` exist in
   `open-software-network/os-june-releases`.
5. Runs `pnpm lint` and `pnpm test`.
6. Builds the bundled Hermes runtime with
   `scripts/bundle-hermes-runtime-windows.ps1`: the pinned hermes-agent
   checkout, a relocatable CPython, Python deps, prebuilt dashboard UI, and a
   relocatable `bin/hermes.exe` launcher.
7. Authenticode-signs the bundled Hermes `.exe`, `.dll`, and `.pyd` binaries
   when certificate secrets are configured.
8. Builds the Windows NSIS installer with production OS Accounts and June API
   configuration embedded as fallback runtime config.
9. Signs the app executable and NSIS installer through
   `scripts/windows-sign.ps1` when certificate secrets are configured.
10. Verifies Authenticode status for the executable and installer when signing
    is configured, checks the updater signature file exists, and inspects the
    NSIS payload, including the bundled Hermes launcher and Python runtime.
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

If Authenticode signing was enabled, confirm the signature status is `Valid` and
the publisher is Open Software Network. If signing was not enabled, expect
Windows to report an unsigned installer and do not describe it as signed. In
both cases, confirm the app launches as June, the sign-in copy mentions
recording and notes without dictation, and the bundled agent starts on a clean VM
with no Python installed. Record from the microphone and generate a note against
production June API before linking the installer publicly.

For updater validation after a second Windows release, install an older
updater-capable Windows build, run **June -> Check for updates...**, confirm the
prompt shows the new version, install, and verify the app exits for the Windows
installer handoff and relaunches cleanly on the new version.

If expected Authenticode validation, updater signature validation, sign-in,
recording, or update installation fails, do not promote the Windows installer.
