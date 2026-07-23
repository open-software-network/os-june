---
status: accepted
date: 2026-07-09
---

# The dictation paste target is pinned when the recording stops

The **dictation helper** delivers a transcript by writing it to the clipboard
and posting a synthetic Cmd+V. It chooses the app that receives that keystroke
by **pinning** the frontmost app at the instant the recording stops
(`FocusTargetController.pinCurrentTarget()`, called from `stopActiveRecording()`
before the recorder is torn down), and it pastes into that pinned app and no
other. The pin must precede teardown: the selected-microphone recorder stops
asynchronously, so pinning after it would reopen the drift window.

If the pinned app has quit by the time the transcript comes back, June does not
paste at all: it leaves the transcript on the clipboard and tells the user to
paste it themselves, the same way it behaves when Accessibility trust is
missing.

The helper also waits (bounded) for the pinned app to actually become
frontmost, and posts Cmd+V **only** if it is frontmost at that moment. If the
app never comes forward, the paste is abandoned to the clipboard rather than
typed somewhere else. The clipboard-restore delay is measured from the
keystroke rather than from the start of the paste.

## Why

Dictation is not a single instant. The user releases push-to-talk, and only
then does June upload the audio, run dictation transcription upstream, and
optionally run a cleanup pass over the text. That round trip is fast for a
short phrase and slow for a long one: **the wait scales with how long the user
spoke.**

The helper used to resolve the paste destination at paste time, reading
`lastExternalApp` — a field that a global `didActivateApplicationNotification`
observer rewrites on *every* app activation. Those two facts compose into a
time-of-check/time-of-use bug:

- Short dictation: the gap is under a second, nothing else activates, the
  paste lands where the user was typing. It looks like it always works.
- Long dictation: the gap is many seconds. Anything that activates an app in
  that window silently repoints the target, and the transcript is typed into
  whatever app now happens to be frontmost.

Because the transcript is written to dictation history regardless of where the
paste went, the failure presents as "dictation didn't work, but the text is in
the dictation tab" (JUN-226) rather than as an error.

Pinning removes the drift window entirely. It also makes the target a single
source of truth: Rust already snapshots `targetBundleIdentifier` at
`recording_ready` to decide cleanup context, and the helper now pastes into
that same app instead of into a value that has since moved.

Two smaller assumptions on the same path were wrong for the same reason:
`NSRunningApplication.activate(options:)` is asynchronous, so posting Cmd+V a
fixed 180 ms later could deliver the keystroke to the app that was *still*
frontmost; and scheduling the clipboard restore from the start of the paste
left the target only ~520 ms to read a clipboard that was about to be yanked
back.

## Alternatives considered

- **Insert into June's own composer directly, and keep clipboard+Cmd+V only for
  external apps.** Rejected for now: it splits dictation delivery into two
  code paths with different failure modes, and it fixes the bug only when the
  target is June. Dictation into any other app would keep drifting. Pinning
  fixes every target with one mechanism.
- **Pass the pinned target from Rust in the `paste_text` command.** Rust holds
  the bundle id already, and this would make the choice unit-testable in Rust.
  Rejected because a bundle id cannot distinguish two running instances, while
  the helper can hold the exact `NSRunningApplication`. Correctness beat
  testability; the helper ships in the same binary, so there is no wire
  contract to keep compatible.
- **Fall back to the frontmost app when the pinned app is gone.** Rejected: it
  reintroduces the failure this ADR exists to prevent, and typing a long
  transcript into an unintended app is worse than asking the user to press
  Cmd+V.
- **Pin when the recording starts rather than when it stops.** Equivalent in
  practice (the frontmost app rarely changes while the user is holding
  push-to-talk and speaking), and stop-time pinning matches the instant Rust
  already snapshots the bundle id.

## Consequences

- If the user deliberately switches apps while a long dictation is
  transcribing, the text lands in the app they dictated from, not the one they
  moved to. This is intended, and is what "paste into the chat I had active"
  means.
- A new `paste_target_unavailable` error can reach the HUD. It is not in the
  silent-error allowlist, so it renders as a real error rather than being
  swallowed as "nothing recorded".
- The helper's paste path is now the only place that decides the target.
  `activateLastExternalApp()` is gone; `lastExternalApp` remains only as the
  live source that `pinCurrentTarget()` samples.
- A pinned app that refuses to come forward (a modal, another full-screen
  space, a refused cooperative activation) now yields `paste_target_unavailable`
  instead of a paste. That is the intended trade: activation is a request, not
  a command, and typing a private transcript into the wrong window is worse
  than asking for a manual Cmd+V.
- The guarantee is "frontmost when we posted the keystroke", not "frontmost
  when the keystroke was delivered". The remaining window is the time to post a
  CGEvent, versus the multi-second window this ADR removes. It cannot be closed
  from outside the window server.
- `paste_text` carries no state guard, so if the helper crashes and respawns
  while Rust is still transcribing, the replacement process has no pin and
  reports `paste_target_unavailable`. The transcript is still on the clipboard
  and in dictation history, so nothing is lost.

## Windows addendum (2026-07-22)

Real Windows QA proved that exact top-level `HWND` activation plus the 180 ms
settle period is not sufficient to focus a WebView2 DOM editor. The helper can
successfully submit `Ctrl+V` to June's window while the ProseMirror composer
receives nothing. External applications still use the exact pinned-window
activation and `SendInput` path above without change.

Windows therefore has one exact-request exception. A Dictate-button request may
carry a bounded random request id. Rust validates it and injects June's process
id; the frontend is never trusted to identify its process. The helper binds
that metadata only when the command actually starts recording, captures the
start target, and offers direct composer delivery only when the exact `HWND`
and process also match the stop target. Toggle commands that stop an existing
recording cannot retarget it.

For an eligible request, `paste_text` must echo the id and the helper must
revalidate the exact window and process. It writes the transcript to the
clipboard, emits a correlated `agent_composer` transcript, and waits up to two
seconds for June to acknowledge insertion. A matching success permits the
usual delayed restoration of a previous clipboard backup. Rejection, timeout,
or any missing, stale, malformed, or mismatched identity leaves the transcript
on the clipboard with manual-paste guidance. Direct delivery never falls back
to synthetic `Ctrl+V`; this avoids duplicate or misdirected text.

### Correction (2026-07-23)

Direct delivery revalidates the initiating `HWND` and process identity but does
not require that window to remain foreground when recording stops. The stop
foreground is the destination only for synthetic paste. For direct delivery,
the random request id and captured draft key pin the composer, and the frontend
rejects a changed session or missing editor. Requiring start and stop foreground
handles to match incorrectly rejected valid flows stopped through the separate
non-focusable dictation HUD without adding routing safety.
