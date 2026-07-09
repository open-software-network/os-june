---
status: accepted
date: 2026-07-09
---

# Windows dictation uses a platform-native helper process

Windows dictation uses a native sidecar helper, `june-dictation-helper.exe`, that speaks the same newline-delimited JSON command/event protocol as the macOS dictation helper. The helper owns Windows-native concerns: global shortcuts, microphone recording, audio levels, foreground-window pinning, clipboard writes, and synthetic `Ctrl+V`. The Tauri app keeps the existing Rust coordinator responsibilities: auth and credits, June API dictation transcription, cleanup, dictation history, HUD events, and frontend command routing.

The shared protocol is documented in [dictation-helper-protocol.md](../dictation-helper-protocol.md).

## Why

Dictation has to cross native boundaries that Tauri and the web frontend should not own directly:

- Windows global shortcuts need a Win32 message loop or keyboard hook.
- Microphone recording and input-level metering need long-lived native state.
- Safe paste requires pinning and verifying an exact native window handle.
- UIPI and foreground restrictions can prevent focus or input delivery into elevated or protected apps.
- Clipboard access needs retry/backoff and conservative fallback behavior.

Keeping those details in a helper mirrors the existing macOS architecture and preserves the Rust/frontend contract that already handles June API calls and history correctly.

## Decision

- Build and bundle a Windows helper executable from `src-tauri/native/windows-dictation-helper`.
- Preserve the existing JSON-lines helper protocol instead of introducing a separate Windows Tauri command surface.
- Pin the Windows paste target when recording stops by storing the foreground `HWND` and diagnostics.
- On paste, send `Ctrl+V` only after the pinned `HWND` is verified as the foreground window.
- If the window is gone, focus is blocked, or input is restricted by UIPI, leave the transcript on the clipboard and emit a paste-target error so the user can press `Ctrl+V` manually.
- Use temp WAV files for the first Windows implementation so the existing Rust upload path can stay file-based.
- Treat Windows microphone permission requests as a settings/guidance flow rather than assuming Windows can show a macOS-style prompt.
- Do not require macOS Accessibility on Windows.

## Alternatives considered

- **Implement Windows dictation inside the Tauri process.** Rejected because the main app would inherit low-level hooks, message loops, clipboard races, and crash risk. A helper isolates those native responsibilities and matches macOS.
- **Use paste-time foreground window resolution.** Rejected for the same reason as [ADR-0014](0014-pinned-dictation-paste-target.md): the dictation round trip can outlast the user's attention, and typing into whatever is foreground later is unsafe.
- **Use in-memory audio handoff.** Deferred. The existing Rust coordinator expects a file path and already uploads files to June API. WAV files are easier to inspect and recover while bringing Windows up.
- **Run June or the helper elevated to bypass UIPI.** Rejected. Elevation would increase risk and still would not be appropriate as the default user experience. Clipboard fallback is safer.

## Consequences

- Windows and macOS helpers must keep their shared protocol compatible.
- Windows can support dictation without June API changes.
- Windows paste into elevated apps may fall back to clipboard by design.
- Authenticode signing and AV false-positive monitoring matter because the helper uses global hotkeys and synthetic input.
- Future improvements, such as in-memory audio handoff, richer Windows privacy diagnostics, or system audio capture, can be added behind the same protocol without changing the frontend contract.
