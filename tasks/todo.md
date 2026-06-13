# Dictation HUD second-run visual stability

- [x] Read the attached transcript and screenshot.
- [x] Inspect the follow-up hitch video.
- [x] Inspect the dictation HUD state and sizing flow.
- [x] Identify the likely clipping race.
- [x] Patch the HUD sizing path with a scoped fix.
- [x] Patch fresh second-run shows to snap-size before reveal.
- [x] Add focused regression coverage.
- [x] Run targeted tests and lint/build checks as practical.
- [x] Fix the residual second-run hitch: snap in-flight transitions before
      measuring the pill, and make the settle-pass heal a non-animated snap.
- [x] Lengthen the exit dissolve to a perceptible fade (240ms native alpha +
      matching CSS).
- [x] Float error messages in a caption line below/above the pill (frostless
      chrome + dictation_hud_caption_fits_below) instead of stretching the
      pill; pill shows the compact error mark.
- [x] Rework the error reveal to attach above/below the HUD based on screen
      position, using a CSS reveal while the native window stays pre-sized.
- [x] Add focused regression coverage for above/below placement and sizing.
- [x] Run targeted HUD tests and practical build checks.
- [x] Make every visible dictation HUD state frostless to match the agent HUD
      surface instead of using native vibrancy for compact states.
- [x] Keep frostless chrome through exit so the oversized error window cannot
      flash a native frosted rectangle while fading.
- [x] Tint the compact error icon red and verify the HUD tests/build.
- [x] Remove the error-layer retract on dismiss so expanded errors fade in
      place instead of animating back into the recorder pill.
- [x] Preserve the outgoing processing HUD layout during paste-complete fade
      so it cannot flash back to the waveform recorder controls.
- [x] Audit all `hideHud()` callers and preserve meeting prompt layout during
      native meeting exit.
- [x] Make listening to transcribing skip the content morph/native resize
      animation so the processing HUD appears seamlessly.
- [x] Compare dictation HUD transparency with the agent HUD surface.

## Notes

The screenshot shows the right side of the dictation pill cut by the window
edge. The report says the issue heals on the next transition, which points at
the native HUD window keeping a stale frame until a later resize/show pass.
The follow-up video shows a related second-run hitch: the interrupted fresh
listening show becomes visible while the native frame is still resizing from a
stale width. Fresh shows now set native alpha to zero, snap-size the window,
then reveal; visible state-to-state transitions still use the morph.

## Verification

- `pnpm test -- src/test/hud-meeting.test.ts`
- `pnpm test`
- `pnpm run lint`
- `pnpm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
