# JUN-391 paint-first launch

JUN-391 changes the launch tradeoff from "avoid a workspace fallback flash" to
"show a stable first frame as soon as React can render." The account/loading
shell and the code-split workspace skeleton are acceptable launch states. A
blank window while optional IPC or workspace parsing completes is not.

## Launch boundary

`src/main.tsx` mounts React without awaiting the experimental-flags IPC or the
default Agent workspace import. After the browser has had one paint
opportunity, the frontend starts three independent background tasks:

1. hydrate experimental flags;
2. ask the native shell to run browser cleanup and start the dictation helper;
3. prefetch the remaining code-split workspaces during idle time.

The native command returns immediately after scheduling its worker. Browser
profile cleanup retains a one-time gate that also runs before the first managed
browser profile is created, so an unusually early routine cannot race cleanup.
Dictation helper startup reuses the existing shutdown-aware store, settings
reapplication, retry supervision, and a single-flight guard.

## Experimental flag audit

The only persisted experimental capability is Browser use. Its live React
subscribers are Settings and Routines, neither of which is part of the launch
frame. The cached/static default remains available synchronously, and the
persisted value applies when IPC resolves. No flag needs to stay on the
synchronous launch path.

## Measurement

The comparison used Chromium against Vite with a faked Tauri bridge, an
1180 by 780 viewport, warmed frontend assets, and an intentionally delayed
`experimental_flags_get` response of 700 ms. Time to first frame was measured
at the first animation frame after `#root` gained a child over five reloads.

| Build | Samples (ms) | Median |
| --- | --- | --- |
| `origin/main` before JUN-391 | 1867, 877, 887, 869, 877 | 877 ms |
| JUN-391 | 313, 161, 168, 165, 168 | 168 ms |

At 200 ms, the baseline capture is still blank. The changed build shows the
June shell and workspace skeleton. These are controlled development numbers,
not a native release-build benchmark; they isolate the delayed IPC dependency
and document the visible launch sequence. The PR carries both screenshots as
the UI-class evidence.
