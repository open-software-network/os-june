---
status: accepted
date: 2026-07-10
---

# Windows dictation uses a hybrid global hotkey and keyboard hook

Windows dictation shortcuts use `RegisterHotKey` for shortcut reservation and
initial key-down activation, plus a narrowly scoped `WH_KEYBOARD_LL` hook for
push-to-talk release detection and interactive shortcut capture.

The Windows v1 shortcut contract supports a modifier plus one non-modifier
physical key. Supported modifier labels are `Ctrl`, `Alt`, `Shift`, and `Win`.
The helper rejects bare keys, modifier-only chords, `Fn`, and `pressCount`
values other than `1`. Windows shortcut identity is based on the DOM `code`
and corresponding virtual-key mapping, not a localized character.

The helper emits both `shortcut_key_down` and `shortcut_key_up` for a
push-to-talk shortcut. Toggle shortcuts activate from `shortcut_key_down` only.
The hook does not replace `RegisterHotKey`: reservation remains authoritative
so conflicts with shortcuts owned by Windows or another application can be
reported instead of silently accepting an unusable setting.

## Why

The Rust dictation activation controller models push-to-talk as a held chord.
It starts recording on key-down and stops or discards on key-up. Windows
`RegisterHotKey` only posts `WM_HOTKEY` on activation and does not report the
release edge, so using it alone can start a push-to-talk recording that never
stops.

Changing Windows to toggle-only behavior would avoid the native hook, but it
would remove the default push-to-talk interaction and require a different
capability and settings contract from macOS. A low-level keyboard hook supplies
the missing release edge while preserving the existing platform-neutral Rust
state machine.

Using a hook for every activation was also rejected. `RegisterHotKey` provides
operating-system conflict detection and reserves configured shortcuts without
requiring June to inspect the full keyboard stream. The hybrid design limits
the hook's responsibility and the key state it retains.

The same narrow hook can capture the next supported chord when Settings asks
the helper to change a shortcut. Keeping capture in the helper ensures that
capture validation, registration, and activation share one Windows allowlist.

## Alternatives considered

- **Support toggle only on Windows.** Rejected because it removes
  push-to-talk, diverges from the shared interaction model, and leaves the
  existing default shortcut unsafe unless product capabilities and settings
  are also changed.
- **Use only `WH_KEYBOARD_LL`.** Rejected because June would have to reproduce
  shortcut reservation and conflict semantics while observing more keyboard
  activity than necessary.
- **Poll key state after `WM_HOTKEY`.** Rejected because polling introduces a
  timing loop, can miss short releases, and provides no clean mechanism for
  shortcut capture.
- **Support modifier-only or `Fn` shortcuts in v1.** Rejected because these
  cannot use the same `RegisterHotKey` reservation path. They would require
  hook-only activation with weaker conflict behavior and platform-specific
  semantics.

## Consequences

- The helper installs the keyboard hook only on its native hotkey thread and
  keeps minimal state for the configured push-to-talk chord and active capture.
- The helper must not log raw keys or dictated text, and must not swallow normal
  keyboard input. It may suppress a supported chord only while shortcut
  capture is active.
- Key repeat must not produce duplicate shortcut edges.
- Reconfiguration and shutdown must release an active push-to-talk chord so
  Rust cannot remain in a held state after helper state is torn down.
- Authenticode signing and Windows QA are important because low-level keyboard
  hooks can affect antivirus and reputation checks.
- A shortcut is not ready merely because it was saved. The helper emits
  readiness only after registration succeeds and emits a recoverable
  registration failure when Windows refuses the chord.
