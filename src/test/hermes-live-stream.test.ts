import { describe, expect, it } from "vitest";
import { buildAgentChatTurns } from "../lib/agent-chat-runtime";
import type { HermesEventDelivery, JuneHermesEvent } from "../lib/hermes-control-plane";
import {
  appendHermesLiveEvent,
  createHermesLiveStream,
  hermesLiveEvents,
  reconcileHermesLiveStream,
  type HermesLiveStream,
} from "../lib/hermes-live-stream";

const RECEIVED_AT = "2026-07-15T00:00:00.000Z";

type TranscriptEvent = Extract<JuneHermesEvent, { kind: "transcript" }>;
type ReasoningEvent = Extract<JuneHermesEvent, { kind: "reasoning" }>;

function delivery(eventId: string, textOffset?: number): HermesEventDelivery {
  return {
    eventId,
    ...(textOffset === undefined ? {} : { textOffset }),
  };
}

function startEvent(messageId: string, eventId: string, sessionId = "session-1"): TranscriptEvent {
  return {
    kind: "transcript",
    sessionId,
    messageId,
    complete: false,
    failed: false,
    receivedAt: RECEIVED_AT,
    delivery: delivery(eventId),
  };
}

function deltaEvent(
  messageId: string,
  delta: string,
  eventId: string,
  textOffset?: number,
  sessionId = "session-1",
): TranscriptEvent {
  return {
    kind: "transcript",
    sessionId,
    messageId,
    delta,
    complete: false,
    failed: false,
    receivedAt: RECEIVED_AT,
    delivery: delivery(eventId, textOffset),
  };
}

function completeEvent(
  messageId: string,
  delta: string,
  eventId: string,
  sessionId = "session-1",
): TranscriptEvent {
  return {
    kind: "transcript",
    sessionId,
    messageId,
    delta,
    complete: true,
    failed: false,
    receivedAt: RECEIVED_AT,
    delivery: delivery(eventId),
  };
}

function reasoningEvent(delta: string, eventId: string, full = false): ReasoningEvent {
  return {
    kind: "reasoning",
    sessionId: "session-1",
    delta,
    ...(full ? { full: true } : {}),
    receivedAt: RECEIVED_AT,
    delivery: delivery(eventId),
  };
}

function append(stream: HermesLiveStream, ...events: JuneHermesEvent[]): HermesLiveStream {
  return events.reduce(appendHermesLiveEvent, stream);
}

function transcriptDeltas(stream: HermesLiveStream, messageId: string): string {
  return hermesLiveEvents(stream)
    .filter(
      (event): event is TranscriptEvent =>
        event.kind === "transcript" &&
        event.messageId === messageId &&
        event.complete !== true &&
        event.delta !== undefined,
    )
    .map((event) => event.delta ?? "")
    .join("");
}

function renderedAssistantText(stream: HermesLiveStream): string {
  return buildAgentChatTurns([], [], hermesLiveEvents(stream))
    .filter((turn) => turn.role === "assistant")
    .flatMap((turn) => turn.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("Hermes live stream", () => {
  it("retains a long answer while compacting adjacent transcript deltas", () => {
    let stream = append(createHermesLiveStream(), startEvent("m1", "start-1"));
    const expected = Array.from({ length: 201 }, (_, index) => String(index % 10)).join("");

    for (const [index, character] of [...expected].entries()) {
      stream = appendHermesLiveEvent(stream, deltaEvent("m1", character, `delta-${index}`));
    }

    expect(transcriptDeltas(stream, "m1")).toBe(expected);
    expect(stream.entries).toHaveLength(2);
    expect(stream.revision).toBe(202);
  });

  it("appends equal text from different deliveries twice", () => {
    const stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "ha", "delta-1"),
      deltaEvent("m1", "ha", "delta-2"),
    );

    expect(transcriptDeltas(stream, "m1")).toBe("haha");
  });

  it("ignores a repeated stable delivery identity", () => {
    const repeated = deltaEvent("m1", "ha", "delta-1");
    const replayedAcrossConnection = {
      ...repeated,
      delivery: { eventId: "delta-1", connectionId: 2, sequence: 8 },
    } satisfies TranscriptEvent;
    const stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      repeated,
      replayedAcrossConnection,
    );

    expect(transcriptDeltas(stream, "m1")).toBe("ha");
    expect(stream.revision).toBe(2);
    expect(stream.seenDeliveries).toHaveLength(2);
  });

  it("withholds an offset-free reconnect replay until the final snapshot proves a suffix", () => {
    let stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "ha", "delta-1"),
      startEvent("m1", "start-2"),
      deltaEvent("m1", "ha", "replay-1"),
      deltaEvent("m1", "!", "replay-2"),
    );

    expect(transcriptDeltas(stream, "m1")).toBe("ha");
    expect(stream.transcriptByMessageId.m1?.replayCandidate).toBe("ha!");

    stream = appendHermesLiveEvent(stream, completeEvent("m1", "haha!", "complete-1"));

    expect(renderedAssistantText(stream)).toBe("haha!");
    expect(renderedAssistantText(stream)).not.toBe("ha!");
    expect(stream.transcriptByMessageId.m1?.complete).toBe(true);
    expect(stream.transcriptByMessageId.m1?.replayCandidate).toBeUndefined();
  });

  it("ignores late deltas and duplicate completes for a completed message", () => {
    const stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "done", "delta-1"),
      completeEvent("m1", "done", "complete-1"),
      deltaEvent("m1", " too late", "late-1"),
      completeEvent("m1", "wrong", "complete-2"),
    );

    expect(renderedAssistantText(stream)).toBe("done");
    expect(hermesLiveEvents(stream)).toHaveLength(3);
  });

  it("buffers source-offset gaps and flushes them in UTF-16 offset order", () => {
    let stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "B", "delta-b", 1),
    );

    expect(transcriptDeltas(stream, "m1")).toBe("");
    expect(stream.transcriptByMessageId.m1?.pendingByTextOffset[1]?.kind).toBe("transcript");

    stream = appendHermesLiveEvent(stream, deltaEvent("m1", "A", "delta-a", 0));

    expect(transcriptDeltas(stream, "m1")).toBe("AB");
    expect(stream.transcriptByMessageId.m1?.nextTextOffset).toBe(2);
    expect(stream.transcriptByMessageId.m1?.pendingByTextOffset).toEqual({});
  });

  it("keeps full reasoning snapshots separate from compacted incremental reasoning", () => {
    const stream = append(
      createHermesLiveStream(),
      reasoningEvent("first ", "reasoning-1"),
      reasoningEvent("thought", "reasoning-2"),
      reasoningEvent("first thought", "reasoning-full", true),
      reasoningEvent(" next", "reasoning-3"),
    );
    const reasoning = hermesLiveEvents(stream).filter(
      (event): event is ReasoningEvent => event.kind === "reasoning",
    );

    expect(reasoning).toHaveLength(3);
    expect(reasoning.map(({ delta, full }) => ({ delta, full }))).toEqual([
      { delta: "first thought", full: undefined },
      { delta: "first thought", full: true },
      { delta: " next", full: undefined },
    ]);
  });

  it("marks only exact persisted messages through the revision watermark without pruning entries", () => {
    let stream = append(
      createHermesLiveStream(),
      startEvent("exact", "exact-start"),
      deltaEvent("exact", "persisted", "exact-delta"),
      completeEvent("exact", "persisted", "exact-complete"),
      startEvent("conflict", "conflict-start"),
      deltaEvent("conflict", "live text", "conflict-delta"),
      completeEvent("conflict", "live text", "conflict-complete"),
    );
    const throughRevision = stream.revision;
    stream = append(
      stream,
      startEvent("later", "later-start"),
      deltaEvent("later", "new text", "later-delta"),
      completeEvent("later", "new text", "later-complete"),
    );
    const canonicalEntries = stream.entries;

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision,
      persistedMessages: new Map([
        ["exact", "persisted"],
        ["conflict", "lagging"],
        ["later", "new text"],
      ]),
    });

    expect(reconciled.persistedMessageIds).toEqual({ exact: true });
    expect(reconciled.entries).toBe(canonicalEntries);
    expect(hermesLiveEvents(reconciled)).toEqual(hermesLiveEvents(stream));
  });
});
