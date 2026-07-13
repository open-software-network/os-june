# UI Contract: Tauri Notes MVP

## Primary Window

The MVP has one persistent desktop window.

```text
┌──────────────────┬──────────────────────────────────────────┐
│ OS Notetaker     │ Notes list or selected note editor        │
│ + New Folder     │                                          │
│ All Notes        │                                          │
│ Folder A         │                                          │
│ Folder B         │                                          │
└──────────────────┴──────────────────────────────────────────┘
```

## Sidebar Contract

Required visible items:
- App name: `OS Notetaker`
- `+ New Folder`
- `All Notes`
- User folders

Behavior:
- Selecting `All Notes` shows all notes in reverse chronological order.
- Selecting a folder filters the note list to notes assigned to that folder.
- Creating a folder inserts it into the sidebar and selects it.
- The sidebar must not show workspace, auth, billing, meetings, calendar, chat, sharing, or system audio controls.

## Notes List Contract

Empty state:
- Shows a prominent create-note action.
- Uses direct, non-marketing copy.
- If a selected folder is empty, offers a clear create-note or assignment path.

Populated state:
- Shows note title or `New note` placeholder.
- Shows enough preview/status metadata to identify the note.
- Sorts by `created_at` in reverse chronological order.
- Shows processing/retry status when a note is `recording`, `validating`, `transcribing`, `generating`, `failed`, or `recoverable`.

## Note Editor Contract

Required elements:
- Large title field with placeholder `New note`.
- Tabs: `Notes` and `Transcription`.
- Editable generated note area under `Notes`.
- Scrollable raw transcript under `Transcription`.
- Folder assignment control.
- Bottom recording controls with `Pause`, waveform/audio visualization, and `Done` while recording.

Behavior:
- Title and note body autosave.
- Switching tabs does not lose edits.
- If transcript is missing because processing failed, `Transcription` shows the failure and retry action when saved audio exists.
- Ready notes keep raw transcript available even after note content is edited.

## Recording Control Contract

Idle/draft:
- User can start microphone recording from a draft note.
- If microphone permission is denied, UI shows the recovery path and does not pretend to record.

Recording:
- UI shows active state, elapsed time, live waveform/level movement, and reachable `Pause` and `Done`.
- Sustained silence does not add live warning copy. After Done, validation explains unusable audio before note generation.
- `Pause` toggles to resume behavior without losing previously recorded audio.

Done/finalizing:
- UI shows finalizing/validating before transcription.
- The note does not advance to provider processing unless validation passes.

Failed:
- Local audio failures explain what failed.
- Provider failures preserve audio and offer retry.

Recoverable:
- Startup surfaces recoverable recordings with validate/discard actions.

## Visual Direction

- Native-feeling macOS desktop utility, not a marketing page.
- Use a Liquid Glass-inspired treatment as polish for the Tauri webview, not as a hard dependency on native SwiftUI `glassEffect`.
- Apply restrained translucency, blur, subtle borders, and vibrancy-like foreground contrast to the sidebar, editor surfaces, and bottom recorder controls.
- Keep glass styling functional: recording, paused, validating, transcribing, failed, and ready states must remain more legible than the visual effect.
- Avoid heavy custom blur layers, opaque overlays, decorative gradients, and one-off glass surfaces that make the app feel busy or reduce accessibility.
- Ensure the UI degrades cleanly to solid macOS-style surfaces if webview glass effects are unavailable, slow, or visually unclear.
- Fluid but restrained transitions and immediate control feedback.
- Stable sidebar/list/editor geometry.
- Polished spacing and typography, with no nested card-heavy layout.
- Recorder visualization near the bottom center of the note screen.
