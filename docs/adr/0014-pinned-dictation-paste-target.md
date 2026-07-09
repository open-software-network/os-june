---
status: accepted
date: 2026-07-09
---

# The dictation paste target is pinned when the recording stops

The **dictation helper** delivers a transcript by writing it to the clipboard
and posting a synthetic Cmd+V. It chooses the app that receives that keystroke
by **pinning** the frontmost app at the instant the recording stops
(`FocusTargetController.pinCurrentTarget()`, called from
`emitRecordingReady()`), and it pastes into that pinned app and no other.

If the pinned app has quit by the time the transcript comes back, June does not
paste at all: it leaves the transcript on the clipboard and tells the user to
paste it themselves, the same way it behaves when Accessibility trust is
missing.

The helper also waits for the pinned app to actually become frontmost before
posting Cmd+V (bounded, then it posts anyway), and it measures the
clipboard-restore delay from the keystroke rather than from the start of the
paste.

## Why

Dictation is not a single instant. The user releases push-to-talk, and only
then does June upload the audio, transcribe it upstream, and optionally run a
cleanup pass over the text. That round trip is fast for a short phrase and slow
for a long one: **the wait scales with how long the user spoke.**

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
