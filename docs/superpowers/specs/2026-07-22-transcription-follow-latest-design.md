# Transcription follow-latest design

**Status:** Approved on 2026-07-22

**Target:** Keep the newest live transcript preview visible while the user is
following the live edge, without interrupting someone who scrolls upward to
read earlier conversation turns.

## Problem

The meeting-note Transcription tab renders new live preview chunks correctly,
but it does not update the owning `.note-detail-scroll` position when the
content grows. Once the transcript is taller than the viewport, the newest
preview can appear below the visible area and make the surface look stale.

The scroller already has a React ref in `App.tsx`, but that ref is currently
used only to attach scrollbar-fade behavior. `NoteEditor` appends or coalesces
preview turns without any follow-latest coordination.

## Selected behavior

Use a sticky follow-latest mode:

- While the Transcription tab is open and the scroller is at or within 48 px of
  the bottom, new live-preview or persisted transcript content scrolls to the
  latest visible turn.
- If the user scrolls farther than 48 px from the bottom, follow mode pauses.
  Content updates must not move the reader's position while paused.
- Scrolling back within the threshold resumes follow mode.
- Opening the Transcription tab during an active recording lands at the latest
  turn.
- Programmatic scrolling uses smooth motion by default and instant motion when
  `prefers-reduced-motion: reduce` is active.
- The first version adds no floating "Latest" button. A user resumes following
  by scrolling back to the bottom.

This follows the interaction model already used by the Agent transcript while
keeping the meeting-note implementation limited to its existing scroller.

## Architecture

The follow state belongs beside `noteDetailScrollRef` in `App.tsx`, because
that element is the actual scroll owner for both Notes and Transcription.
`NoteEditor` should remain responsible for transcript presentation, not for
reaching into a parent scroll container.

Add a small, independently testable helper for the bottom-distance calculation
and keep mutable follow state in refs so scroll events do not cause application
rerenders. A short-lived programmatic-scroll guard prevents the smooth scroll's
own intermediate events from being mistaken for the user scrolling upward. The
scroll listener updates whether the reader is following only outside that
guard. A post-render effect reacts to the selected note's displayed transcript
coverage and live-preview signature only while the Transcription tab is active.

When the effect decides to follow, it schedules the scroll after React has
committed the new transcript DOM. It scrolls the existing note-detail container
to its `scrollHeight`; it does not target a particular transcript row, so it
continues to work when adjacent preview chunks are coalesced into one growing
turn.

## Data flow

1. A `live-transcript-event` updates `liveTranscriptEvents`, or note polling
   updates persisted Source turns.
2. `NoteEditor` rerenders the ordered visible transcript.
3. The follow effect observes the transcript signature after the commit.
4. If the Transcription tab is active and follow mode is still armed, the
   note-detail scroller moves to its new bottom.
5. Outside a guarded programmatic scroll, a user-originated upward scroll
   recomputes the bottom distance and disarms follow mode once it crosses the
   threshold.

## State transitions and edge cases

- Switching notes resets follow mode for the new note. If its Transcription tab
  is active during a recording, the scroller lands at the latest turn.
- Switching from Notes to Transcription during an active recording arms follow
  mode and lands at the latest content.
- Switching away from Transcription performs no transcript-driven scrolling.
- Reconciliation that replaces preview spans with authoritative saved-audio
  rows follows the same rule: it moves only while follow mode is armed.
- Source filtering does not force follow mode back on after the reader has
  scrolled upward.
- Preview failure and empty preview chunks require no special handling because
  they do not change the displayed transcript signature.
- The behavior must tolerate test and restricted browser environments where
  `scrollTo` or `matchMedia` is unavailable.

## Testing

Add focused frontend coverage for:

- bottom-distance threshold calculation;
- a new preview update scrolling while the reader is at the live edge;
- an upward user scroll suppressing later automatic movement;
- smooth programmatic scroll events not disarming follow mode;
- returning to the bottom rearming follow mode;
- opening Transcription during an active recording landing at the latest turn;
- reduced-motion preference selecting instant scrolling; and
- persisted-turn reconciliation respecting the same follow state.

Existing live-preview ordering, coalescing, and reconciliation tests remain the
source of truth for transcript contents. The new tests cover only scroll
coordination and must not duplicate those semantics.

## Out of scope

- Backend, capture, chunking, transcription, persistence, and billing changes.
- Changes to the eight-second preview cadence.
- A floating "Latest" control or unread-preview counter.
- Auto-opening the Transcription tab when recording begins.
- Promoting preview text into the persisted transcript.

The change is desktop-frontend only and does not require a June API deploy.
