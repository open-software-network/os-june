import type { LiveTranscriptEventDto } from "./tauri";

const LIVE_TRANSCRIPT_EVENT_LIMIT = 32;

export function upsertLiveTranscriptEvent(
  current: LiveTranscriptEventDto[],
  next: LiveTranscriptEventDto,
) {
  const events = current
    .filter((event) => !isSameLiveSegment(event, next))
    .concat(next)
    .sort(compareLiveTranscriptEvents);
  return coalesceAdjacentLiveTranscriptEvents(events).slice(
    -LIVE_TRANSCRIPT_EVENT_LIMIT,
  );
}

function coalesceAdjacentLiveTranscriptEvents(
  events: LiveTranscriptEventDto[],
) {
  const coalesced: LiveTranscriptEventDto[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (previous && isSameLiveTurn(previous, event)) {
      coalesced[coalesced.length - 1] = mergeLiveTranscriptEvents(
        previous,
        event,
      );
    } else {
      coalesced.push(event);
    }
  }
  return coalesced;
}

function isSameLiveSegment(
  left: LiveTranscriptEventDto,
  right: LiveTranscriptEventDto,
) {
  return (
    left.noteId === right.noteId &&
    left.sessionId === right.sessionId &&
    left.source === right.source &&
    left.segmentId === right.segmentId
  );
}

function isSameLiveTurn(
  left: LiveTranscriptEventDto,
  right: LiveTranscriptEventDto,
) {
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

function compareLiveTranscriptEvents(
  left: LiveTranscriptEventDto,
  right: LiveTranscriptEventDto,
) {
  return (
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.segmentId.localeCompare(right.segmentId)
  );
}
