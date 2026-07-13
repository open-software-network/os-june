# June extension

The MV3 extension half of Browser use (JUN-287, ADR 0017). This walking
skeleton pairs the extension with the running June app over Chrome native
messaging and a signed shim; page control arrives in later slices.

## How pairing works

1. The June app runs an authenticated loopback listener
   (`src-tauri/src/extension_host.rs`) and writes a connection descriptor
   (port + per-run token) into its app data dir.
2. In June's settings, "Set up browser extension" writes the Chrome native
   messaging host manifest, which pins this extension's id and points at the
   `june-nm-shim` binary.
3. The extension's background worker calls `chrome.runtime.connectNative`;
   Chrome spawns the shim, which authenticates to the listener and relays
   frames both ways.
4. The extension sends `hello` with its protocol version; the app answers
   `hello_ok` (paired) or `hello_incompatible` (the popup shows an update
   prompt).

## Develop

```sh
pnpm --filter june-extension build   # writes dist/
pnpm --filter june-extension test    # vitest
pnpm --filter june-extension typecheck
```

Load it unpacked: run the June app once (dev build is fine), click "Set up
browser extension" in Settings -> Agent, then open `chrome://extensions`,
enable Developer mode, choose "Load unpacked", and select `extension/dist`.
The manifest's pinned `key` keeps the id stable (`adckhkfngpnenaapncoipkalcfpjbgcn`),
so the registered host manifest matches every local build.

## Rotating the pinned key

`node extension/scripts/generate-key.mjs` prints a fresh key and the id it
pins. Update `public/manifest.json` (`key`) and
`src-tauri/src/extension_host.rs` (`EXTENSION_ID`) together.
