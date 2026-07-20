# Desktop release runner

Use a dedicated Mac Studio self-hosted GitHub Actions runner for signed macOS
desktop releases. The release workflows target this runner when
`macos-runner = mac-studio`.

## Required labels

Register the runner for the `open-software-network/os-june` repo with these
labels:

```text
self-hosted
macOS
ARM64
desktop-release
```

`self-hosted`, `macOS`, and `ARM64` are added by GitHub for an Apple Silicon
macOS runner. Add `desktop-release` as the custom label. Keep this label unique
to the trusted Mac Studio so production signing secrets cannot run on a generic
self-hosted machine.

## One-time setup

1. In GitHub, open `open-software-network/os-june` -> Settings -> Actions ->
   Runners -> New self-hosted runner.
2. Choose `macOS` and `ARM64`, then install the runner under a dedicated
   directory such as `~/actions-runner/os-june-desktop-release`.
3. Configure it with the `desktop-release` label.
4. Install it as a launchd service so it survives restarts:

```sh
./svc.sh install
./svc.sh start
```

The workflow installs Node and pnpm through GitHub Actions, but the host still
needs the Apple and Rust build toolchain:

```sh
xcode-select --install
brew install uv
softwareupdate --install-rosetta --agree-to-license
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

After setup, confirm the expected tools are available to the runner user:

```sh
xcode-select -p
xcrun notarytool --version
rustc --version
cargo --version
uv --version
/usr/bin/arch -x86_64 /usr/bin/uname -m
```

The final command must print `x86_64`. Rosetta is a release capability: the
Hermes bundle gate executes the Intel launcher and native dependencies under
Rosetta and fails closed when that path is unavailable.

## Release use

The macOS release workflows expose `macos-runner`:

- `mac-studio` uses `["self-hosted","macOS","ARM64","desktop-release"]`.
- `github-hosted` uses `blacksmith-6vcpu-macos-15` as the fallback.

Use `mac-studio` for normal RC and promote runs. Use `github-hosted` only if the
Mac Studio runner is offline or being maintained.

The workflows cache `.tauri-hermes/hermes` under the versioned universal-v2
key by runner OS, Hermes pin, bundling script, architecture audit, native-import
smoke, patcher, and sitecustomize source. The bundle itself must carry the exact
`arm64 x86_64` architecture stamp, so a prior host-only cache is rejected. On a
cache hit, `scripts/bundle-hermes-runtime.sh` re-signs every Mach-O file with the
current Developer ID identity, audits both trees, and runs both relocated
launchers before the app build.
