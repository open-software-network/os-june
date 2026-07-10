# Dictation helper protocol

June talks to each platform-native **dictation helper** over newline-delimited JSON on stdin/stdout. The helper owns native capture, global shortcuts, paste-target pinning, clipboard insertion, and platform permission/status probes. Rust owns auth, June API calls, cleanup, dictation history, and event routing to the frontend.

The protocol is intentionally shared by macOS and Windows helpers so the Rust coordinator and frontend event model stay platform-neutral.

## Transport

- Rust launches the helper as a child process with piped stdin, stdout, and stderr.
- Each command is one UTF-8 JSON object followed by `\n` on stdin.
- Each event is one UTF-8 JSON object followed by `\n` on stdout.
- Stderr is diagnostic-only and may be forwarded to logs.
- Unknown command fields and unknown event payload fields must be ignored.

## Commands

All commands have a `type` string. Payload fields are command-specific.

- `ping`: asks the helper to prove the command loop is alive.
- `get_permission_status`: emits `permission_status`.
- `request_microphone_permission`: opens or triggers the platform microphone permission flow, then emits `permission_status`.
- `request_accessibility_permission`: macOS-only permission request. Windows treats this as already granted because dictation paste does not use macOS Accessibility.
- `list_microphones`: emits `microphone_devices`.
- `set_microphone`: selects a microphone by optional `id` and `name`.
- `set_shortcut`: configures one shortcut. The payload includes `kind` (`push_to_talk` or `toggle`), `keyCode`, `code`, `label`, `pressCount`, and `modifiers`. On Windows v1, a shortcut must contain one or more of `Ctrl`, `Alt`, `Shift`, or `Win` plus one supported non-modifier physical key. Windows rejects bare keys, modifier-only chords, `Fn`, and `pressCount` values other than `1`.
- `start_shortcut_capture`: starts interactive shortcut capture for a `kind`. On Windows, capture accepts the same modifier-plus-key shape as registration; `Escape` cancels capture.
- `cancel_shortcut_capture`: cancels shortcut capture.
- `start_listening`: starts dictation recording.
- `stop_and_paste`: pins the paste target, stops recording, and emits `recording_ready` when the audio file is finalized.
- `toggle_listening`: toggles between `start_listening` and `stop_and_paste`.
- `paste_text`: writes cleaned text to the pinned target or leaves it on the clipboard if safe paste cannot be verified.
- `discard_recording`: stops and discards an active recording.
- `discard_mic_test`: stops any microphone test state.
- `shutdown`: exits the helper.

## Events

All events have a `type` string and optional `payload` object.

- `ready`: helper has started.
- `pong`: response to `ping`.
- `permission_status`: reports `microphone` and `accessibility` states.
- `microphone_devices`: reports available devices and selected/default device ids.
- `hotkey_trigger_ready`: recoverable readiness event emitted only after the helper has successfully registered the configured shortcuts. It is not a dictation completion event.
- `hotkey_trigger_unavailable`: recoverable registration-status event emitted when the platform refuses or cannot represent a configured shortcut. Its payload identifies `kind`, `shortcut`, a machine-readable `code`, and a user-facing `message`. The setting remains persisted but must not be presented as ready.
- `shortcut_key_down`, `shortcut_key_up`: shortcut activation edges consumed by Rust. Windows emits both edges for push-to-talk; toggle activation uses `shortcut_key_down` only. The legacy `hotkey_trigger` event may be accepted for compatibility but new helpers emit explicit edges.
- `shortcut_capture_started`, `shortcut_capture_cancelled`, `shortcut_captured`, `shortcut_capture_error`: shortcut capture lifecycle. Capture errors are recoverable status and do not imply that an active dictation failed.
- `listening_started`: active dictation recording began.
- `audio_level`: current input level.
- `finalizing_transcript`: recording stopped and helper is finalizing local audio.
- `recording_ready`: payload includes `path` and optional `durationMs`, `observedAudioLevel`, and platform target diagnostics. Rust uploads this file to June API.
- `final_transcript`: paste flow completed successfully.
- `recording_discarded`: active recording was discarded.
- `paste_target_unavailable` or `paste_target_restricted`: helper left text on the clipboard because safe paste into the pinned target could not be verified.
- `error`: terminal or recoverable helper error with `code` and `message`. Errors on an active recording or paste flow may terminate that operation. Hotkey readiness, registration conflicts, and shortcut capture validation use their dedicated status events instead of a terminal dictation error.

## Windows shortcut contract

Windows v1 uses `RegisterHotKey` for reservation and initial key-down, with a narrowly scoped low-level keyboard hook for push-to-talk release and shortcut capture. See [ADR-0016](adr/0016-windows-dictation-keyboard-hook.md).

Supported shortcut shapes contain at least one of `Ctrl`, `Alt`, `Shift`, or `Win`, and exactly one supported non-modifier physical key. Labels use those Windows names, while `code` carries the layout-independent DOM physical-key code. The supported non-modifier allowlist is letters, digits, punctuation keys, `Space`, `Tab`, `Enter`, `Backspace`, `Escape`, arrow keys, and `F1` through `F12`.

Windows v1 does not support bare non-modifier keys, modifier-only chords, `Fn`, or double-press shortcuts (`pressCount: 2`). The frontend and Rust command boundary must reject these shapes before persistence, and the helper must validate them again before registration.

## Paste-target safety

The helper must pin the paste target when recording stops, before transcription begins. It must not re-resolve the live foreground app/window at paste time.

On Windows, the helper pins the current `HWND` and may include diagnostics such as process id or window title in event payloads. On `paste_text`, it must verify the window still exists, try to bring it foreground, and only send `Ctrl+V` if the pinned window is foreground. If focus is blocked by UIPI or OS focus policy, the helper leaves the transcript on the clipboard and emits a paste-target error.

On macOS, the helper pins the running application and only posts `Cmd+V` after the pinned app becomes frontmost.

## Audio files

The first Windows implementation writes temporary WAV files. `recording_ready.payload.path` is the absolute path Rust uploads to `/v1/dictate`.
