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
needs the Apple and Rust build toolchain. Install both Rust macOS targets:
RC builds default to Apple Silicon, while stable promotion still builds a
universal app.

```sh
xcode-select --install
brew install uv
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
```

## Release use

The macOS release workflows expose `macos-runner`:

- `mac-studio` uses `["self-hosted","macOS","ARM64","desktop-release"]`.
- `github-hosted` uses `macos-latest` as the fallback.

Use `mac-studio` for normal RC and promote runs. Use `github-hosted` only if the
Mac Studio runner is offline or being maintained.

The workflows cache `.tauri-hermes/hermes` by runner OS, runner architecture,
Hermes pin, and bundling script. On a cache hit, `scripts/bundle-hermes-runtime.sh`
reuses the restored runtime, re-signs every Mach-O file with the current
Developer ID identity, and runs the relocation self-test before the app build.

The RC workflow also enables `sccache` through GitHub Actions cache. The first
run after a dependency or Rust source change may still compile normally, but
later RC builds for nearby commits should reuse compiler outputs without
restoring `src-tauri/target` directly.
