import type { LiveTranscriptEventDto, TranscriptDto } from "./tauri";

const LIVE_TRANSCRIPT_COHERENCE_GAP_MS = 500;

export function upsertLiveTranscriptEvent(
  current: LiveTranscriptEventDto[],
  next: LiveTranscriptEventDto,
) {
  const events = current
    .filter((event) => !isSameLiveSegment(event, next))
    .concat(next)
    .sort(compareLiveTranscriptEvents);
  return events;
}

/**
 * Coalescing is presentation-only. The stored preview events retain their
 * segment ids so persisted transcript spans can replace exactly the preview
 * time range they supersede.
 */
export function coalesceLiveTranscriptEventsForDisplay(events: LiveTranscriptEventDto[]) {
  const coalesced: LiveTranscriptEventDto[] = [];
  for (const event of [...events].sort(compareLiveTranscriptEvents)) {
    const previous = coalesced.at(-1);
    if (
      previous &&
      isSameLiveTurn(previous, event) &&
      event.startMs - previous.endMs <= LIVE_TRANSCRIPT_COHERENCE_GAP_MS
    ) {
      coalesced[coalesced.length - 1] = mergeLiveTranscriptEvents(previous, event);
    } else {
      coalesced.push(event);
    }
  }
  return coalesced;
}

/**
 * Saved-audio transcript rows are authoritative. A row may only supersede a
 * live preview from the same recording session, Source, and time span;
 * legacy rows without a recording session id deliberately reconcile nothing.
 */
export function reconcileLiveTranscriptEvents(
  events: LiveTranscriptEventDto[],
  persisted: TranscriptDto[],
) {
  return events.filter(
    (event) =>
      !persisted.some(
        (turn) =>
          turn.recordingSessionId === event.sessionId &&
          turn.source === event.source &&
          rangesOverlap(event.startMs, event.endMs, turn.startMs, turn.endMs),
      ),
  );
}

/** Clear completed-session previews while preserving a currently active take. */
export function clearTerminalLiveTranscriptEvents(
  events: LiveTranscriptEventDto[],
  noteId: string,
  protectedSessionIds: readonly string[] = [],
) {
  const protectedSessions = new Set(protectedSessionIds);
  return events.filter(
    (event) => event.noteId !== noteId || protectedSessions.has(event.sessionId),
  );
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart?: number, rightEnd?: number) {
  return (
    rightStart !== undefined &&
    rightEnd !== undefined &&
    leftStart < rightEnd &&
    rightStart < leftEnd
  );
}

function isSameLiveSegment(left: LiveTranscriptEventDto, right: LiveTranscriptEventDto) {
  return (
    left.noteId === right.noteId &&
    left.sessionId === right.sessionId &&
    left.source === right.source &&
    left.segmentId === right.segmentId
  );
}

function isSameLiveTurn(left: LiveTranscriptEventDto, right: LiveTranscriptEventDto) {
  return (
    left.noteId === right.noteId &&
    left.sessionId === right.sessionId &&
    left.sourceMode === right.sourceMode &&
    left.source === right.source
  );
}

function mergeLiveTranscriptEvents(
  left: LiveTranscriptEventDto,
  right: LiveTranscriptEventDto,
): LiveTranscriptEventDto {
  return {
    ...left,
    startMs: Math.min(left.startMs, right.startMs),
    endMs: Math.max(left.endMs, right.endMs),
    text: appendLiveTranscriptText(left.text, right.text),
    language: right.language ?? left.language,
    stability: right.stability,
  };
}

function appendLiveTranscriptText(left: string, right: string) {
  const leftText = left.trim();
  const rightText = right.trim();
  if (!leftText) return rightText;
  if (!rightText) return leftText;
  return `${leftText} ${rightText}`;
}

function compareLiveTranscriptEvents(left: LiveTranscriptEventDto, right: LiveTranscriptEventDto) {
  return (
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.segmentId.localeCompare(right.segmentId)
  );
}
