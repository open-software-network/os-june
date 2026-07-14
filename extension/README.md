# June extension

The MV3 extension half of Browser use (ADR 0017). It pairs with the running
June app over Chrome native messaging and a signed shim, then drives only tabs
it created for the active broker session. Task tabs stay in a `June` tab group
and keep Chrome's debugger banner visible while attached.

The current driver starts and closes sessions, opens, lists, switches, and
closes task tabs, accepts one-use share codes created by an explicit popup
gesture, and supports navigation, accessibility snapshots, and viewport
screenshots. Click, fill, press, and back are implemented in later slices.
Both the Rust broker and this extension keep independent ownership registries;
pre-existing tabs are never attached or read unless explicitly shared. Shared
tabs show Chrome's debugger banner while attached and are detached, never
closed, when the task ends, the share is revoked, or the broker disconnects.

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
