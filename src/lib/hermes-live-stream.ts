import type { JuneHermesEvent } from "./hermes-control-plane";

export type HermesLiveStream = {
  revision: number;
  entries: Array<{ event: JuneHermesEvent; revision: number }>;
  seenDeliveries: string[];
  transcriptByMessageId: Record<
    string,
    {
      complete: boolean;
      visibleLength: number;
      replayCandidate?: string;
      nextTextOffset?: number;
      pendingByTextOffset: Record<number, JuneHermesEvent>;
    }
  >;
  persistedMessageIds: Record<string, true>;
};

type TranscriptEvent = Extract<JuneHermesEvent, { kind: "transcript" }>;
type TranscriptState = HermesLiveStream["transcriptByMessageId"][string];
type StreamEntry = HermesLiveStream["entries"][number];

export function createHermesLiveStream(): HermesLiveStream {
  return {
    revision: 0,
    entries: [],
    seenDeliveries: [],
    transcriptByMessageId: {},
    persistedMessageIds: {},
  };
}

export function appendHermesLiveEvent(
  current: HermesLiveStream,
  event: JuneHermesEvent,
): HermesLiveStream {
  const deliveryKey = stableDeliveryKey(event);
  if (deliveryKey && current.seenDeliveries.includes(deliveryKey)) return current;

  const next: HermesLiveStream = {
    revision: current.revision + 1,
    entries: [...current.entries],
    seenDeliveries: deliveryKey ? [...current.seenDeliveries, deliveryKey] : current.seenDeliveries,
    transcriptByMessageId: { ...current.transcriptByMessageId },
    persistedMessageIds: current.persistedMessageIds,
  };

  if (event.kind === "transcript" && event.messageId) {
    appendTranscriptEvent(next, event);
  } else {
    appendSemanticEntry(next, event, next.revision);
  }
  return next;
}

export function hermesLiveEvents(current: HermesLiveStream): JuneHermesEvent[] {
  return current.entries.map(({ event }) => event);
}

export function reconcileHermesLiveStream(
  current: HermesLiveStream,
  options: {
    throughRevision: number;
    persistedMessages: ReadonlyMap<string, string>;
  },
): HermesLiveStream {
  let persistedMessageIds: Record<string, true> | undefined;

  for (const [messageId, persistedText] of options.persistedMessages) {
    if (current.persistedMessageIds[messageId]) continue;
    const completeRevision = completedMessageRevision(current.entries, messageId);
    if (completeRevision === undefined || completeRevision > options.throughRevision) continue;
    if (!current.transcriptByMessageId[messageId]?.complete) continue;
    if (visibleTranscriptText(current.entries, messageId) !== persistedText) continue;

    persistedMessageIds ??= { ...current.persistedMessageIds };
    persistedMessageIds[messageId] = true;
  }

  if (!persistedMessageIds) return current;
  return {
    ...current,
    // Canonical entries intentionally stay in place. Their segmentation and
    // object identity are observable while the live surface remains mounted.
    persistedMessageIds,
  };
}

function appendTranscriptEvent(stream: HermesLiveStream, event: TranscriptEvent) {
  const messageId = event.messageId as string;
  const existing = stream.transcriptByMessageId[messageId];
  const isStart = event.complete !== true && event.delta === undefined;

  if (isStart) {
    if (existing?.complete) return;
    if (existing) {
      stream.transcriptByMessageId[messageId] = {
        ...existing,
        pendingByTextOffset: { ...existing.pendingByTextOffset },
        replayCandidate: "",
      };
      return;
    }

    stream.transcriptByMessageId[messageId] = emptyTranscriptState();
    appendSemanticEntry(stream, event, stream.revision);
    return;
  }

  const state: TranscriptState = existing
    ? {
        ...existing,
        pendingByTextOffset: { ...existing.pendingByTextOffset },
      }
    : emptyTranscriptState();
  if (state.complete) return;

  if (event.complete === true) {
    const baseline = visibleTranscriptText(stream.entries, messageId);
    const snapshot = event.delta ?? "";
    const monotonicText = snapshot.startsWith(baseline) ? snapshot : baseline;
    appendSemanticEntry(stream, { ...event, delta: monotonicText }, stream.revision);
    stream.transcriptByMessageId[messageId] = {
      complete: true,
      visibleLength: monotonicText.length,
      pendingByTextOffset: {},
      ...(state.nextTextOffset === undefined ? {} : { nextTextOffset: monotonicText.length }),
    };
    return;
  }

  const textOffset = event.delivery?.textOffset;
  if (textOffset !== undefined) {
    appendOffsetTranscriptEvent(stream, messageId, state, event, textOffset);
    stream.transcriptByMessageId[messageId] = state;
    return;
  }

  const delta = event.delta ?? "";
  if (state.replayCandidate !== undefined) {
    state.replayCandidate += delta;
    stream.transcriptByMessageId[messageId] = state;
    return;
  }

  if (delta) appendSemanticEntry(stream, event, stream.revision);
  state.visibleLength = visibleTranscriptText(stream.entries, messageId).length;
  stream.transcriptByMessageId[messageId] = state;
}

function appendOffsetTranscriptEvent(
  stream: HermesLiveStream,
  messageId: string,
  state: TranscriptState,
  event: TranscriptEvent,
  textOffset: number,
) {
  const accepted = tryAppendOffsetChunk(stream, messageId, event, textOffset);
  if (!accepted && state.pendingByTextOffset[textOffset] === undefined) {
    state.pendingByTextOffset[textOffset] = event;
  }

  let flushed = true;
  while (flushed) {
    flushed = false;
    const visibleLength = visibleTranscriptText(stream.entries, messageId).length;
    const pendingOffsets = Object.keys(state.pendingByTextOffset)
      .map(Number)
      .filter((offset) => offset <= visibleLength)
      .sort((left, right) => left - right);

    for (const pendingOffset of pendingOffsets) {
      const pending = state.pendingByTextOffset[pendingOffset];
      if (pending?.kind !== "transcript") continue;
      if (!tryAppendOffsetChunk(stream, messageId, pending, pendingOffset)) continue;
      delete state.pendingByTextOffset[pendingOffset];
      flushed = true;
      break;
    }
  }

  state.visibleLength = visibleTranscriptText(stream.entries, messageId).length;
  state.nextTextOffset = state.visibleLength;
}

function tryAppendOffsetChunk(
  stream: HermesLiveStream,
  messageId: string,
  event: TranscriptEvent,
  textOffset: number,
): boolean {
  const visibleText = visibleTranscriptText(stream.entries, messageId);
  if (textOffset > visibleText.length) return false;

  const delta = event.delta ?? "";
  const overlapLength = Math.min(delta.length, Math.max(visibleText.length - textOffset, 0));
  if (visibleText.slice(textOffset, textOffset + overlapLength) !== delta.slice(0, overlapLength)) {
    return false;
  }

  const suffix = delta.slice(Math.max(visibleText.length - textOffset, 0));
  if (suffix) {
    appendSemanticEntry(stream, { ...event, delta: suffix }, stream.revision);
  }
  return true;
}

function appendSemanticEntry(stream: HermesLiveStream, event: JuneHermesEvent, revision: number) {
  const lastIndex = stream.entries.length - 1;
  const last = stream.entries[lastIndex];
  if (
    last?.event.kind === "transcript" &&
    event.kind === "transcript" &&
    canCoalesceTranscript(last.event, event)
  ) {
    stream.entries[lastIndex] = {
      event: {
        ...event,
        delta: (last.event.delta ?? "") + (event.delta ?? ""),
      },
      revision,
    };
    return;
  }
  if (
    last?.event.kind === "reasoning" &&
    event.kind === "reasoning" &&
    canCoalesceReasoning(last.event, event)
  ) {
    stream.entries[lastIndex] = {
      event: {
        ...event,
        delta: last.event.delta + event.delta,
      },
      revision,
    };
    return;
  }
  stream.entries.push({ event, revision });
}

function canCoalesceTranscript(previous: TranscriptEvent, current: TranscriptEvent): boolean {
  return (
    previous.complete !== true &&
    current.complete !== true &&
    previous.delta !== undefined &&
    current.delta !== undefined &&
    previous.sessionId === current.sessionId &&
    previous.messageId === current.messageId
  );
}

function canCoalesceReasoning(
  previous: Extract<JuneHermesEvent, { kind: "reasoning" }>,
  current: Extract<JuneHermesEvent, { kind: "reasoning" }>,
): boolean {
  return (
    previous.full !== true && current.full !== true && previous.sessionId === current.sessionId
  );
}

function stableDeliveryKey(event: JuneHermesEvent): string | undefined {
  const { delivery } = event;
  if (!delivery) return undefined;
  if (delivery.eventId) return `event:${delivery.eventId}`;
  if (delivery.connectionId !== undefined && delivery.sequence !== undefined) {
    return `connection:${delivery.connectionId}:${delivery.sequence}`;
  }
  return undefined;
}

function emptyTranscriptState(): TranscriptState {
  return {
    complete: false,
    visibleLength: 0,
    pendingByTextOffset: {},
  };
}

function visibleTranscriptText(entries: StreamEntry[], messageId: string): string {
  let text = "";
  for (const { event } of entries) {
    if (event.kind !== "transcript" || event.messageId !== messageId) continue;
    if (event.complete === true) {
      const snapshot = event.delta ?? "";
      if (snapshot.startsWith(text)) text = snapshot;
    } else if (event.delta !== undefined) {
      text += event.delta;
    }
  }
  return text;
}

function completedMessageRevision(entries: StreamEntry[], messageId: string): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.event.kind === "transcript" &&
      entry.event.messageId === messageId &&
      entry.event.complete === true
    ) {
      return entry.revision;
    }
  }
  return undefined;
}
