# Tabs Behind Dialog

- [x] Inspect the screenshot and current tab/dialog layering.
- [x] Locate the shared CSS stacking context for titlebar tabs and dialogs.
- [x] Patch layering so modal dialogs render above the tab strip.
- [x] Add focused regression coverage.
- [x] Run targeted tests and practical build checks.

## Notes

The screenshot shows the titlebar tab strip painted above an open dialog
backdrop. The fix should preserve the custom titlebar drag behavior while
making modal dialog layers clear the titlebar surface.

## Verification

- `pnpm test -- src/test/dialog-layering.test.ts src/test/tab-bar.test.tsx`
- `pnpm run lint`
- `pnpm run build`
- `pnpm test`
- `curl -I http://127.0.0.1:1422/` against a temporary Vite server returned
  `200 OK`

## Previous Work

# Microphone Source Label Note Leak

- [x] Inspect the screenshot and identify whether the leak is generated note text or transcript display.
- [x] Trace dual-source transcript assembly into note generation.
- [x] Patch the generation prompt and provider output cleanup for source-label leakage.
- [x] Run focused provider tests.
- [x] Run practical backend verification.

## Notes

The screenshot shows `Microphone:` leaking into the Notes tab. Dual-source
generation sends source-labeled transcript lines (`Microphone:` / `System:`)
to the note generator, but the generation contract did not explicitly mark
those labels as metadata. The provider now tells the model source labels are
not spoken words and strips leading source labels from generated note lines as
defense in depth.

Codex review correctly pointed out that source-label cleanup must be scoped to
dual-source labeled transcripts so single-source notes can preserve genuinely
spoken text like `System: restart the service`. The request path now carries an
explicit `transcriptSourceLabels` flag. Codex also caught that Markdown output
could still leak labels behind list or heading markers, so the cleanup handles
common Markdown prefixes before stripping source labels.

Codex also caught a subtler dual-source case: the spoken content itself can
begin with source-like words after the outer source label, for example
`Microphone: System: restart the service`. Cleanup is now transcript-aware and
only strips a generated source prefix when the stripped text matches the spoken
content from the labeled transcript. That preserves a correct generated line
like `System: restart the service` while still cleaning a leaked outer label
like `Microphone: System: restart the service`.

## Verification

- `cargo test --manifest-path scribe-api/Cargo.toml -p scribe-providers venice::tests --locked`
- `cargo test --manifest-path scribe-api/Cargo.toml -p scribe-providers --locked`
- `cargo check --manifest-path src-tauri/Cargo.toml --locked`
- `cargo clippy --manifest-path scribe-api/Cargo.toml --all-targets --all-features --locked -- -D warnings`
- `cargo test --manifest-path scribe-api/Cargo.toml --all-targets --all-features --locked`
- `cargo test --manifest-path src-tauri/Cargo.toml --test processing --locked`

## Previous Work

# Window Drag With Hidden Tabs

- [x] Inspect the screenshot and existing titlebar drag implementation.
- [x] Locate the tab strip and titlebar layering.
- [x] Patch tab strip background drag handling without making controls draggable.
- [x] Add focused regression coverage.
- [x] Run targeted tests and practical build checks.

## Notes

The screenshot points at the main window chrome around the tab strip. The app
already has a full-window `.titlebar-drag` layer under the tab bar, but the tab
bar is above it, so empty tab-strip space needs the same explicit
`startDragging()` pointer path used by the base titlebar region.

## Verification

- `pnpm test -- src/test/tab-bar.test.tsx`
- `pnpm run lint`
- `pnpm run build`
- `curl http://127.0.0.1:1422/` against a temporary Vite server returned
  `200 OK`
- `pnpm test`

## Previous Work

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

## Previous Notes

The screenshot shows the right side of the dictation pill cut by the window
edge. The report says the issue heals on the next transition, which points at
the native HUD window keeping a stale frame until a later resize/show pass.
The follow-up video shows a related second-run hitch: the interrupted fresh
listening show becomes visible while the native frame is still resizing from a
stale width. Fresh shows now set native alpha to zero, snap-size the window,
then reveal; visible state-to-state transitions still use the morph.

## Previous Verification

- `pnpm test -- src/test/hud-meeting.test.ts`
- `pnpm test`
- `pnpm run lint`
- `pnpm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
