# Transcription follow-latest implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Transcription tab following newly rendered live preview and saved-audio Turns while the reader is at the live edge, pause following when they scroll upward, resume when they return to the bottom, and land on the latest Turn when they open the tab during an active recording.

**Architecture:** Keep `.note-detail-scroll` as the single scroll owner. Add a focused React hook that tracks whether that viewport is within 48 px of the bottom, distinguishes downward programmatic smooth scrolling from user interruption, and scrolls only when a stable transcript-content key changes. `App` derives the selected note's preview events and persisted Turns, enables the hook only for the Transcription tab, and forces follow mode when that tab opens on the note currently being recorded.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, jsdom, existing Tauri event state. No new dependency, CSS, native code, or June API change.

## Global Constraints

- Use the canonical terms **Transcription**, **Live transcript preview**, **Turn**, and **Source** from `CONTEXT.md`; do not introduce “realtime transcription.”
- Preserve `.note-detail-scroll` as the scroll viewport and preserve its existing `attachScrollThumbFade` behavior.
- A viewport is at the live edge when `scrollHeight - scrollTop - clientHeight <= 48`.
- While follow mode is armed, a preview or persisted-Turn display change scrolls to the latest content.
- A user scroll upward beyond the threshold disarms follow mode. Scrolling back within the threshold rearms it.
- Wheel, touch, keyboard, scrollbar, and trackpad interruption must work through native scroll events; wheel and touch events must also cancel an in-flight programmatic glide before the next animation frame.
- Programmatic downward scroll events must not accidentally disarm follow mode. An upward scroll during a programmatic glide is treated as user interruption.
- Opening Transcription on the note with the active recording lands at the latest Turn. Opening a historical transcript must not unexpectedly jump to the bottom.
- Use smooth scrolling unless `prefers-reduced-motion: reduce` matches, in which case use `auto`.
- Saved-audio Turns remain authoritative. This change must not alter preview coalescing, preview reconciliation, event filtering, persistence, polling, billing, or recording state.
- Do not add a “Latest” button in this pass.
- Do not modify `NoteEditor.tsx`, `app.css`, Rust, or `june-api/`; the existing component tree and styles are sufficient.
- Follow test-driven development: observe each focused test fail for the intended missing behavior before implementing it.

---

## File responsibility map

- Modify `src/lib/live-transcript-preview.ts`: derive a deterministic key from fields that can change the visible or ordered transcription.
- Create `src/lib/use-follow-latest-scroll.ts`: own the 48 px threshold, follow/pause/resume state, programmatic-scroll guard, reduced-motion behavior, and listener cleanup.
- Modify `src/app/App.tsx`: derive selected-note transcript inputs, enable the hook only for Transcription, and pass the already-filtered preview list to `NoteEditor`.
- Modify `src/test/live-transcript-preview.test.ts`: prove equivalent polling objects keep a stable key and visible changes change it.
- Create `src/test/use-follow-latest-scroll.test.tsx`: prove the hook's threshold, follow, pause, resume, active-recording entry, programmatic-scroll, and reduced-motion behavior.
- Modify `src/test/app-notes-reliability.test.tsx`: prove the real App wires live preview events to the note-detail viewport and respects user interruption.

---

### Task 1: Define a stable visible-transcript content key

**Files:**

- Modify: `src/test/live-transcript-preview.test.ts`
- Modify: `src/lib/live-transcript-preview.ts`

- [ ] **Step 1: Add failing content-key tests**

Import `transcriptFollowLatestKey` in `src/test/live-transcript-preview.test.ts` and add tests with these assertions:

```ts
it("keeps the follow-latest key stable across equivalent polling objects", () => {
  const preview = [liveEvent()];
  const persisted = [persistedTurn()];

  expect(transcriptFollowLatestKey(preview, persisted)).toBe(
    transcriptFollowLatestKey(
      preview.map((event) => ({ ...event })),
      persisted.map((turn) => ({ ...turn })),
    ),
  );
});

it("changes the follow-latest key when visible transcript content changes", () => {
  const initial = transcriptFollowLatestKey([liveEvent()], []);
  const revisedPreview = transcriptFollowLatestKey(
    [liveEvent({ text: "Revised preview words", endMs: 9000 })],
    [],
  );
  const persistedReplacement = transcriptFollowLatestKey([], [persistedTurn()]);

  expect(revisedPreview).not.toBe(initial);
  expect(persistedReplacement).not.toBe(initial);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing export is the failure**

Run:

```bash
pnpm exec vitest run src/test/live-transcript-preview.test.ts
```

Expected: FAIL because `transcriptFollowLatestKey` is not exported.

- [ ] **Step 3: Implement the deterministic key**

Add this exported function after `authoritativeTranscriptCoverageKey` in `src/lib/live-transcript-preview.ts`:

```ts
/**
 * Stable dependency key for changes that can alter the visible transcription.
 * App polling reconstructs DTO objects, so React effects must depend on values,
 * not array identity.
 */
export function transcriptFollowLatestKey(
  live: LiveTranscriptEventDto[],
  persisted: TranscriptDto[],
) {
  return JSON.stringify({
    live: live.map((event) => [
      event.noteId,
      event.sessionId,
      event.sourceMode,
      event.source,
      event.segmentId,
      event.startMs,
      event.endMs,
      event.text,
      event.language ?? null,
      event.stability,
    ]),
    persisted: persisted.map((turn) => [
      turn.id,
      turn.recordingSessionId ?? null,
      turn.spanId ?? null,
      turn.sourceMode ?? null,
      turn.source ?? null,
      turn.startMs ?? null,
      turn.endMs ?? null,
      turn.turnIndex ?? null,
      turn.text,
      turn.language ?? null,
      turn.status,
      turn.lastError ?? null,
      turn.recordedSilence ?? false,
    ]),
  });
}
```

Keep `authoritativeTranscriptCoverageKey` unchanged: it intentionally tracks only authoritative overlap for cleanup, while this new key tracks display changes for scrolling.

- [ ] **Step 4: Re-run the focused test**

Run:

```bash
pnpm exec vitest run src/test/live-transcript-preview.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/live-transcript-preview.ts src/test/live-transcript-preview.test.ts
git commit -m "test: track visible transcript changes"
```

---

### Task 2: Build the follow-latest scroll controller

**Files:**

- Create: `src/test/use-follow-latest-scroll.test.tsx`
- Create: `src/lib/use-follow-latest-scroll.ts`

**Public interface:**

```ts
export const FOLLOW_LATEST_BOTTOM_THRESHOLD_PX = 48;

export function isNearScrollBottom(
  scroller: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold?: number,
): boolean;

export function useFollowLatestScroll(options: {
  scrollRef: RefObject<HTMLElement | null>;
  active: boolean;
  contentKey: string;
  scopeKey: string;
  followOnActivate: boolean;
}): void;
```

- [ ] **Step 1: Create the test harness and failing threshold tests**

Create `src/test/use-follow-latest-scroll.test.tsx`. Use `renderHook`, `act`, `fireEvent`, `createRef`, and a real detached `div`. Define writable `scrollTop`, fixed `scrollHeight`/`clientHeight`, and a `scrollTo` spy that clamps to `scrollHeight - clientHeight` and dispatches `scroll`:

```ts
function createScroller(scrollTop = 600) {
  let currentScrollTop = scrollTop;
  const element = document.createElement("div");
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 400 },
    scrollTop: {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = value;
      },
    },
  });
  const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    currentScrollTop = Math.min(Number(top), 600);
    element.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperty(element, "scrollTo", { configurable: true, value: scrollTo });
  document.body.append(element);
  const ref = createRef<HTMLElement>();
  Object.defineProperty(ref, "current", { configurable: true, value: element });
  return {
    element,
    ref,
    scrollTo,
    setScrollTop: (value: number) => {
      currentScrollTop = value;
    },
  };
}
```

Assert that distance 49 is not near bottom and distance 48 is near bottom. Then run:

```bash
pnpm exec vitest run src/test/use-follow-latest-scroll.test.tsx
```

Expected: FAIL because the hook module does not exist.

- [ ] **Step 2: Add behavior tests before implementation**

Add focused tests that rerender the hook and assert:

1. Changing `contentKey` while initially at the bottom calls `scrollTo({ top: 1000, behavior: "smooth" })`.
2. After setting `scrollTop` to `100` and dispatching `scroll`, changing `contentKey` does not call `scrollTo`.
3. After that pause, setting `scrollTop` back to `600` and dispatching `scroll` rearms the next content-key change.
4. Changing `active` from false to true with `followOnActivate: true` scrolls even when parked at `100`.
5. Changing `active` from false to true with `followOnActivate: false` does not move a historical transcript parked at `100`.
6. A programmatic downward `scroll` event does not disarm the following content-key change.
7. `wheel` followed by an upward `scroll` cancels an in-flight glide and pauses the following content-key change.
8. A mocked `matchMedia` result with `matches: true` changes `behavior` to `"auto"`.

Use `afterEach` to restore mocks, clear timers, and empty `document.body`.

- [ ] **Step 3: Implement the hook**

Create `src/lib/use-follow-latest-scroll.ts` with:

- `FOLLOW_LATEST_BOTTOM_THRESHOLD_PX = 48`.
- `PROGRAMMATIC_SCROLL_TIMEOUT_MS = 800`, matching the existing agent transcript glide guard.
- refs for `shouldFollow`, `lastScrollTop`, `programmaticScroll`, timeout id, pending animation-frame id, previous active state, previous content key, and previous scope key.
- one listener effect that attaches only while `active` and cleans up `scroll`, `wheel`, `touchmove`, and the timeout.
- one content effect that detects content changes and activation/scope changes, then performs the scroll.

The listener logic must follow this shape:

```ts
const updateStickiness = () => {
  const previousScrollTop = lastScrollTopRef.current;
  lastScrollTopRef.current = scroller.scrollTop;
  if (programmaticScrollRef.current) {
    if (scroller.scrollTop < previousScrollTop) {
      clearProgrammaticScroll();
      shouldFollowRef.current = isNearScrollBottom(scroller);
      return;
    }
    shouldFollowRef.current = true;
    if (isNearScrollBottom(scroller)) clearProgrammaticScroll();
    return;
  }
  shouldFollowRef.current = isNearScrollBottom(scroller);
};
```

Wheel and touch handlers must call `clearProgrammaticScroll()` and schedule `updateStickiness` with `requestAnimationFrame`, so direct scroll events remain the common path for mouse, keyboard, scrollbar, and trackpad input. Cancel the pending animation frame during cleanup as well as removing listeners and clearing the timeout.

The content effect must enforce these rules:

```ts
const scopeChanged = previousScopeKeyRef.current !== scopeKey;
const justActivated = active && !previousActiveRef.current;
const contentChanged = !scopeChanged && previousContentKeyRef.current !== contentKey;

// Update all previous-value refs on every effect run.

if (scopeChanged) {
  shouldFollowRef.current = scroller ? isNearScrollBottom(scroller) : true;
}
const mustLandOnLatest = followOnActivate && (justActivated || scopeChanged);
if (mustLandOnLatest) shouldFollowRef.current = true;
if (!active || (!contentChanged && !mustLandOnLatest) || !shouldFollowRef.current) return;
```

Before smooth scrolling, arm the programmatic guard and its 800 ms timeout. For reduced motion, clear the guard and use `auto`. Guard `scrollTo` because jsdom does not provide it by default.

- [ ] **Step 4: Run and refine the focused hook tests**

Run:

```bash
pnpm exec vitest run src/test/use-follow-latest-scroll.test.tsx
```

Expected: PASS with no unhandled timers or React `act` warnings.

- [ ] **Step 5: Run the related agent scroll regression test**

Run:

```bash
pnpm exec vitest run src/test/agent-scroll-to-latest.test.tsx
```

Expected: PASS. The new hook is independent and does not change agent transcript scrolling.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/lib/use-follow-latest-scroll.ts src/test/use-follow-latest-scroll.test.tsx
git commit -m "feat: add follow-latest scroll controller"
```

---

### Task 3: Wire follow-latest into the note Transcription tab

**Files:**

- Modify: `src/test/app-notes-reliability.test.tsx`
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Add the failing App integration test**

Add `fireEvent` to the Testing Library import in `src/test/app-notes-reliability.test.tsx`. Add one integration test alongside the existing provisional transcript tests:

```ts
it("follows live transcription until the reader scrolls upward, then resumes at the bottom", async () => {
  await startRecordingOnFirstNote();
  await waitFor(() => expect(mocks.listeners.has("live-transcript-event")).toBe(true));

  const scroller = document.querySelector(".note-detail-scroll");
  expect(scroller).toBeInstanceOf(HTMLElement);
  let scrollTop = 100;
  Object.defineProperties(scroller!, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 400 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
  const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    scrollTop = Math.min(Number(top), 600);
    scroller!.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: scrollTo });

  await userEvent.click(screen.getByRole("button", { name: "Transcription" }));
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" }));
  scrollTo.mockClear();

  const emitPreview = async (segmentId: string, text: string, startMs: number) => {
    await act(async () => {
      await mocks.listeners.get("live-transcript-event")?.({
        payload: {
          noteId: "note-1",
          sessionId: "rec-1",
          sourceMode: "microphonePlusSystem",
          source: "microphone",
          segmentId,
          startMs,
          endMs: startMs + 4000,
          text,
          stability: "final",
        },
      });
    });
  };

  await emitPreview("microphone-0", "First live words", 0);
  await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));

  scrollTo.mockClear();
  scrollTop = 100;
  fireEvent.wheel(scroller!);
  fireEvent.scroll(scroller!);
  await emitPreview("microphone-1", "Words while reading above", 4000);
  expect(scrollTo).not.toHaveBeenCalled();

  scrollTop = 600;
  fireEvent.scroll(scroller!);
  await emitPreview("microphone-2", "Following resumes", 8000);
  await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
});
```

If request-animation-frame scheduling makes the wheel assertion race, wait for one animation frame inside `act` before emitting the second preview. Do not weaken the pause assertion.

Also extend the existing `"polls newly persisted turns while note transcription remains active"` test. Install the same scroll geometry and `scrollTo` spy after the note detail opens, clear any setup calls, then assert that the poll response containing `"The first saved turn is visible."` calls `scrollTo` once. This is the integration proof that authoritative saved-audio Turn replacement uses the same follow state as live preview events.

- [ ] **Step 2: Run the integration test and confirm it fails because App never scrolls**

Run:

```bash
pnpm exec vitest run src/test/app-notes-reliability.test.tsx -t "follows live transcription"
```

Expected: FAIL because opening Transcription, new preview events, and newly persisted Turns do not call `scrollTo`.

- [ ] **Step 3: Derive selected-note transcript inputs once in App**

Update the live-preview import in `src/app/App.tsx` to include `transcriptFollowLatestKey`, and import `useFollowLatestScroll` from `../lib/use-follow-latest-scroll`.

After `selectedNoteId`, derive:

```ts
const selectedNoteLiveTranscript = useMemo(
  () => liveTranscriptEvents.filter((event) => event.noteId === selectedNoteId),
  [liveTranscriptEvents, selectedNoteId],
);
const selectedNoteTranscriptContentKey = useMemo(
  () =>
    transcriptFollowLatestKey(
      selectedNoteLiveTranscript,
      selectedNote?.sourceTranscripts ?? [],
    ),
  [selectedNote?.sourceTranscripts, selectedNoteLiveTranscript],
);
```

Replace the inline `liveTranscriptEvents.filter(...)` passed to `NoteEditor` with `selectedNoteLiveTranscript` so rendering and the scroll key use the same selected-note preview set.

- [ ] **Step 4: Enable the hook only for the active Transcription tab**

Immediately after `noteDetailScrollerActive`, add:

```ts
const transcriptionFollowLatestActive =
  noteDetailScrollerActive && selectedNote?.activeTab === "transcription";
const recordingSelectedNote =
  selectedNoteId !== undefined &&
  selectedNoteId === recordingNoteId &&
  state.recordingStatus !== undefined;

useFollowLatestScroll({
  scrollRef: noteDetailScrollRef,
  active: transcriptionFollowLatestActive,
  contentKey: selectedNoteTranscriptContentKey,
  scopeKey: selectedNoteId ?? "",
  followOnActivate: recordingSelectedNote,
});
```

Do not merge this with the existing scroll-thumb effect. The hook owns follow-latest state; `attachScrollThumbFade` continues to own scrollbar visibility.

- [ ] **Step 5: Run the focused App test**

Run:

```bash
pnpm exec vitest run src/test/app-notes-reliability.test.tsx -t "follows live transcription"
```

Expected: PASS.

- [ ] **Step 6: Run the complete note reliability and preview suites**

Run:

```bash
pnpm exec vitest run src/test/app-notes-reliability.test.tsx src/test/live-transcript-preview.test.ts src/test/use-follow-latest-scroll.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/app/App.tsx src/test/app-notes-reliability.test.tsx
git commit -m "feat: follow live note transcription"
```

---

### Task 4: Verify the frontend change and inspect the real interaction

**Files:**

- No source changes expected.
- If a test or check exposes a defect, fix only the relevant Task 1 to 3 file and rerun its focused test first.

- [ ] **Step 1: Run formatting and lint checks**

Run:

```bash
pnpm check
```

Expected: PASS with no new warnings in changed files.

- [ ] **Step 2: Run TypeScript validation**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the complete frontend test suite**

Run:

```bash
pnpm test
```

Expected: all Vitest tests pass. If the documented `hud-meeting.test.ts` teardown noise appears with zero actual failures, record the exact output and rerun the focused suites; do not hide a real failure.

- [ ] **Step 4: Test the UI in a real browser or Tauri app**

Use the `browser-test-tauri-fe` skill. Start the appropriate preview with `pnpm dev` or `pnpm tauri:dev`, then verify and record:

1. Start a recording and open Transcription while parked above the bottom: it lands on the latest preview.
2. Let at least two new preview chunks arrive: the viewport follows them.
3. Scroll upward beyond 48 px: later chunks appear without moving the viewport.
4. Scroll to the bottom: following resumes on the next chunk.
5. Enable reduced motion in the test environment: the latest-content move is immediate rather than smooth.
6. Open a historical transcript: it does not force a jump to the bottom.

Capture a short recording because this is a motion/interaction change. Do not claim visual verification if live microphone/system capture cannot be exercised; report that limitation explicitly.

- [ ] **Step 5: Inspect the final diff for scope and contract drift**

Run:

```bash
git diff --check
git status --short
git diff HEAD~3 -- src/lib/live-transcript-preview.ts src/lib/use-follow-latest-scroll.ts src/app/App.tsx src/test/live-transcript-preview.test.ts src/test/use-follow-latest-scroll.test.tsx src/test/app-notes-reliability.test.tsx
```

Expected: no whitespace errors; only the planned frontend logic and tests are present. Confirm no changes to `NoteEditor.tsx`, CSS, Rust, June API, dependencies, or API contracts.

- [ ] **Step 6: Record verification in the handoff**

Report focused tests, full frontend tests, `pnpm check`, `pnpm typecheck`, whether the UI was tested visually, and attach the recording if created. State that no June API deploy is needed.
