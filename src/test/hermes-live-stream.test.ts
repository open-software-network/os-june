import { describe, expect, it } from "vitest";
import { buildAgentChatTurns } from "../lib/agent-chat-runtime";
import type { HermesEventDelivery, JuneHermesEvent } from "../lib/hermes-control-plane";
import {
  appendHermesLiveEvent,
  createHermesLiveStream,
  hermesLiveEvents,
  recordHermesIdlessTranscriptPersistenceBoundary,
  reconcileHermesInflightSnapshot,
  reconcileHermesLiveStream,
  type HermesLiveStream,
} from "../lib/hermes-live-stream";

const RECEIVED_AT = "2026-07-15T00:00:00.000Z";

type TranscriptEvent = Extract<JuneHermesEvent, { kind: "transcript" }>;
type ReasoningEvent = Extract<JuneHermesEvent, { kind: "reasoning" }>;
type ToolEvent = Extract<JuneHermesEvent, { kind: "tool" }>;
type PendingActionEvent = Extract<JuneHermesEvent, { kind: "pending_action" }>;
type PendingActionExpirationEvent = Extract<JuneHermesEvent, { kind: "pending_action_expiration" }>;

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

function toolEvent(eventId: string): ToolEvent {
  return {
    kind: "tool",
    sessionId: "session-1",
    toolCallId: "tool-1",
    phase: "start",
    key: "tool-1",
    name: "read_file",
    text: "",
    isClarify: false,
    receivedAt: RECEIVED_AT,
    delivery: delivery(eventId),
  };
}

function approvalRequest(
  requestId: string,
  eventId: string,
  requestIdProvenance?: "payload-fingerprint",
): PendingActionEvent {
  return {
    kind: "pending_action",
    sessionId: "session-1",
    action: {
      kind: "approval",
      requestId,
      ...(requestIdProvenance ? { requestIdProvenance } : {}),
      description: "Connect Todoist?",
      allowPermanent: false,
    },
    receivedAt: RECEIVED_AT,
    delivery: delivery(eventId),
  };
}

function approvalExpiration(requestId: string, eventId: string): PendingActionExpirationEvent {
  return {
    kind: "pending_action_expiration",
    sessionId: "session-1",
    action: { kind: "approval", requestId, reason: "disconnect" },
    receivedAt: RECEIVED_AT,
    delivery: delivery(eventId),
  };
}

function append(stream: HermesLiveStream, ...events: JuneHermesEvent[]): HermesLiveStream {
  return events.reduce((current, event) => appendHermesLiveEvent(current, event), stream);
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
    expect(stream.seenDeliveries.size).toBe(2);
  });

  it("rejects a retired approval replay before it can produce ingress side effects", () => {
    const request = approvalRequest("approval-1", "approval-request-1");
    const retired = append(
      createHermesLiveStream(),
      request,
      approvalExpiration("approval-1", "approval-expiration-1"),
    );
    const replay = {
      ...request,
      delivery: delivery("approval-request-replayed"),
    } satisfies PendingActionEvent;

    expect(appendHermesLiveEvent(retired, replay)).toBe(retired);

    const terminallyRetired = append(createHermesLiveStream(), request, {
      kind: "lifecycle",
      sessionId: "session-1",
      flavor: "terminal",
      status: "completed",
      text: "",
      receivedAt: RECEIVED_AT,
      delivery: delivery("terminal-after-request"),
    });
    expect(appendHermesLiveEvent(terminallyRetired, replay)).toBe(terminallyRetired);
    expect(
      appendHermesLiveEvent(terminallyRetired, replay, {
        runStartRevision: terminallyRetired.revision,
      }),
    ).toBe(terminallyRetired);

    const terminalBeforeNewRequest = appendHermesLiveEvent(createHermesLiveStream(), {
      kind: "lifecycle",
      sessionId: "session-1",
      flavor: "terminal",
      status: "completed",
      text: "",
      receivedAt: RECEIVED_AT,
      delivery: delivery("terminal-before-request"),
    });
    expect(appendHermesLiveEvent(terminalBeforeNewRequest, request)).not.toBe(
      terminalBeforeNewRequest,
    );
  });

  it("allows a repeated legacy approval fingerprint only in a later Agent run", () => {
    const requestId = "legacy:approval.request:shared-payload";
    const request = approvalRequest(requestId, "legacy-request-1", "payload-fingerprint");
    const retired = append(
      createHermesLiveStream(),
      request,
      approvalExpiration(requestId, "legacy-expiration-1"),
    );
    const nextRunStartRevision = retired.revision;
    const laterRequest = {
      ...request,
      delivery: delivery("legacy-request-2"),
    } satisfies PendingActionEvent;

    const acceptedLaterRequest = appendHermesLiveEvent(retired, laterRequest, {
      runStartRevision: nextRunStartRevision,
    });
    expect(acceptedLaterRequest).not.toBe(retired);

    const retiredLaterRequest = appendHermesLiveEvent(
      acceptedLaterRequest,
      approvalExpiration(requestId, "legacy-expiration-2"),
    );
    const replayedLaterRequest = {
      ...request,
      delivery: delivery("legacy-request-2-replayed"),
    } satisfies PendingActionEvent;
    expect(
      appendHermesLiveEvent(retiredLaterRequest, replayedLaterRequest, {
        runStartRevision: nextRunStartRevision,
      }),
    ).toBe(retiredLaterRequest);
  });

  it("drops an unbound legacy retirement before accepting the later run request", () => {
    const requestId = "legacy:approval.request:shared-payload";
    const firstRequest = approvalRequest(requestId, "legacy-request-1", "payload-fingerprint");
    const firstRunRetired = append(
      createHermesLiveStream(),
      firstRequest,
      approvalExpiration(requestId, "legacy-expiration-1"),
    );
    const nextRunStartRevision = firstRunRetired.revision;

    const afterOrphanRetirement = appendHermesLiveEvent(
      firstRunRetired,
      approvalExpiration(requestId, "stale-unbound-expiration"),
      { runStartRevision: nextRunStartRevision },
    );
    expect(afterOrphanRetirement).toBe(firstRunRetired);

    const laterRequest = {
      ...firstRequest,
      delivery: delivery("legacy-request-2"),
    } satisfies PendingActionEvent;
    const acceptedLaterRequest = appendHermesLiveEvent(afterOrphanRetirement, laterRequest, {
      runStartRevision: nextRunStartRevision,
    });

    expect(acceptedLaterRequest).not.toBe(afterOrphanRetirement);
    expect(hermesLiveEvents(acceptedLaterRequest).at(-1)).toMatchObject({
      kind: "pending_action",
      action: {
        requestId,
        instanceId: `${requestId}\u0000run:${nextRunStartRevision}`,
      },
    });
  });

  it("retains old delivery identities while their semantic entries remain", () => {
    let stream = createHermesLiveStream();
    for (let index = 0; index < 2_100; index += 1) {
      stream = appendHermesLiveEvent(stream, reasoningEvent("x", `reasoning-${index}`));
    }

    expect(stream.seenDeliveries.size).toBe(2_100);
    const revision = stream.revision;
    const replayedOld = appendHermesLiveEvent(stream, reasoningEvent("x", "reasoning-0"));
    expect(replayedOld).toBe(stream);
    expect(replayedOld.revision).toBe(revision);
  });

  it("keeps delivery ledgers isolated across branches from the same snapshot", () => {
    const base = createHermesLiveStream();
    const firstBranch = appendHermesLiveEvent(base, reasoningEvent("first", "reasoning-1"));
    const secondBranch = appendHermesLiveEvent(base, reasoningEvent("second", "reasoning-2"));

    expect(base.seenDeliveries.size).toBe(0);
    expect(hermesLiveEvents(firstBranch)).toHaveLength(1);
    expect(hermesLiveEvents(secondBranch)).toHaveLength(1);
    expect(hermesLiveEvents(secondBranch)[0]).toMatchObject({ delta: "second" });

    const combinedBranch = appendHermesLiveEvent(
      secondBranch,
      reasoningEvent("first", "reasoning-1"),
    );
    expect(combinedBranch.revision).toBe(2);
    expect(combinedBranch.seenDeliveries.size).toBe(2);
    expect(hermesLiveEvents(combinedBranch)).toEqual([
      expect.objectContaining({ delta: "secondfirst" }),
    ]);
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

  it("fills only the missing suffix from an in-flight assistant snapshot", () => {
    const base = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "Before ", "delta-1"),
    );

    expect(
      reconcileHermesInflightSnapshot(base, {
        storedSessionId: "session-1",
        assistant: "Before ",
        receivedAt: RECEIVED_AT,
      }),
    ).toBe(base);
    expect(
      reconcileHermesInflightSnapshot(base, {
        storedSessionId: "session-1",
        assistant: "Before",
        receivedAt: RECEIVED_AT,
      }),
    ).toBe(base);
    expect(
      reconcileHermesInflightSnapshot(base, {
        storedSessionId: "session-1",
        assistant: "Conflicting snapshot",
        receivedAt: RECEIVED_AT,
      }),
    ).toBe(base);

    let reconciled = reconcileHermesInflightSnapshot(base, {
      storedSessionId: "session-1",
      assistant: "Before during detach",
      receivedAt: RECEIVED_AT,
    });

    expect(transcriptDeltas(reconciled, "m1")).toBe("Before during detach");
    expect(hermesLiveEvents(reconciled).at(-1)).toMatchObject({
      kind: "transcript",
      messageId: "m1",
    });

    reconciled = appendHermesLiveEvent(
      reconciled,
      deltaEvent("m1", " and after resume", "delta-after-resume"),
    );

    expect(transcriptDeltas(reconciled, "m1")).toBe("Before during detach and after resume");
  });

  it("reconciles an in-flight snapshot for a pinned ID-less assistant stream", () => {
    let stream = append(
      createHermesLiveStream(),
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("start-idless"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Prefix from the origin. ",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("delta-idless"),
      },
    );

    stream = reconcileHermesInflightSnapshot(stream, {
      storedSessionId: "session-1",
      assistant: "Prefix from the origin. Detached-gap recovery.",
      receivedAt: RECEIVED_AT,
    });

    expect(renderedAssistantText(stream)).toBe("Prefix from the origin. Detached-gap recovery.");
    expect(hermesLiveEvents(stream).at(-1)).not.toHaveProperty("messageId");

    stream = appendHermesLiveEvent(stream, {
      kind: "transcript",
      sessionId: "session-1",
      delta: " Continued live.",
      complete: false,
      failed: false,
      receivedAt: RECEIVED_AT,
      delivery: delivery("delta-idless-after-resume"),
    });

    expect(renderedAssistantText(stream)).toBe(
      "Prefix from the origin. Detached-gap recovery. Continued live.",
    );
  });

  it("bootstraps output that began entirely during a detached gap", () => {
    const stream = reconcileHermesInflightSnapshot(createHermesLiveStream(), {
      storedSessionId: "session-1",
      assistant: "The whole response began while the Workspace was detached.",
      receivedAt: RECEIVED_AT,
      bootstrapIfMissing: true,
    });

    expect(renderedAssistantText(stream)).toBe(
      "The whole response began while the Workspace was detached.",
    );
    expect(hermesLiveEvents(stream)).toHaveLength(2);
    expect(hermesLiveEvents(stream)).not.toContainEqual(
      expect.objectContaining({ messageId: expect.anything() }),
    );
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

  it("rejects a duplicate complete before advancing semantic delivery state", () => {
    const completed = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "done", "delta-1"),
      completeEvent("m1", "done", "complete-1"),
    );

    const duplicate = appendHermesLiveEvent(completed, completeEvent("m1", "wrong", "complete-2"));

    expect(duplicate).toBe(completed);
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

  it("keeps a buffered transcript slot ahead of later tool events until its gap resolves", () => {
    const stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "B", "delta-b", 1),
      toolEvent("tool-start"),
      deltaEvent("m1", "A", "delta-a", 0),
    );
    const events = hermesLiveEvents(stream);
    const renderedParts = buildAgentChatTurns([], [], events).flatMap((turn) => turn.parts);

    expect(events.map((event) => event.kind)).toEqual(["transcript", "transcript", "tool"]);
    expect(events[1]).toMatchObject({ kind: "transcript", messageId: "m1", delta: "AB" });
    expect(renderedParts.map((part) => part.type)).toEqual(["text", "tool"]);
  });

  it("keeps a partially resolved offset gap ahead of interleaved activity", () => {
    const stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "C", "delta-c", 2),
      toolEvent("tool-start"),
      deltaEvent("m1", "A", "delta-a", 0),
      {
        kind: "lifecycle",
        sessionId: "session-1",
        flavor: "running",
        status: "working",
        text: "",
        receivedAt: RECEIVED_AT,
        delivery: delivery("lifecycle-running"),
      },
      deltaEvent("m1", "B", "delta-b", 1),
    );
    const events = hermesLiveEvents(stream);

    expect(transcriptDeltas(stream, "m1")).toBe("ABC");
    expect(renderedAssistantText(stream)).toBe("ABC");
    expect(events.map((event) => event.kind)).toEqual([
      "transcript",
      "transcript",
      "tool",
      "lifecycle",
    ]);
  });

  it("drops an impossible offset overlap without pulling later text ahead of activity", () => {
    const stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "A", "delta-a", 0),
      deltaEvent("m1", "X", "delta-conflict", 0),
      toolEvent("tool-start"),
      deltaEvent("m1", "B", "delta-b", 1),
    );

    expect(transcriptDeltas(stream, "m1")).toBe("AB");
    expect(stream.transcriptByMessageId.m1?.pendingByTextOffset).toEqual({});
    expect(hermesLiveEvents(stream).map((event) => event.kind)).toEqual([
      "transcript",
      "transcript",
      "tool",
      "transcript",
    ]);
  });

  it("uses a final snapshot to fill an unresolved buffered slot without moving it past a tool", () => {
    const stream = append(
      createHermesLiveStream(),
      startEvent("m1", "start-1"),
      deltaEvent("m1", "B", "delta-b", 1),
      toolEvent("tool-start"),
      completeEvent("m1", "AB", "complete-1"),
    );
    const events = hermesLiveEvents(stream);

    expect(events.map((event) => event.kind)).toEqual([
      "transcript",
      "transcript",
      "tool",
      "transcript",
    ]);
    expect(events[1]).toMatchObject({ kind: "transcript", messageId: "m1", delta: "AB" });
    expect(renderedAssistantText(stream)).toBe("AB");
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

  it("compacts only the proven ID-less transcript after the current Agent-run boundary", () => {
    const previousReply = append(
      createHermesLiveStream(),
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("previous-idless-start"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Same reply.",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("previous-idless-delta"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Same reply.",
        complete: true,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("previous-idless-complete"),
      },
      {
        kind: "lifecycle",
        sessionId: "session-1",
        flavor: "terminal",
        status: "completed",
        text: "Done.",
        receivedAt: RECEIVED_AT,
        delivery: delivery("previous-terminal"),
      },
    );
    const runStartRevision = previousReply.revision;
    const stream = append(
      previousReply,
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("current-idless-start"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Same reply.",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("current-idless-delta"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Same reply.",
        complete: true,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("current-idless-complete"),
      },
      {
        kind: "lifecycle",
        sessionId: "session-1",
        flavor: "terminal",
        status: "completed",
        text: "Done.",
        receivedAt: RECEIVED_AT,
        delivery: delivery("current-terminal"),
      },
    );

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map(),
      idlessTranscriptRun: {
        runStartRevision,
        persistedAssistantTexts: ["Same reply."],
      },
    });

    expect(
      reconciled.entries.filter(({ event }) => event.kind === "transcript" && !event.messageId),
    ).toEqual(
      previousReply.entries.filter(({ event }) => event.kind === "transcript" && !event.messageId),
    );
  });

  it("aligns a retained ID-less transcript from its proven resume assistant ordinal", () => {
    let stream = createHermesLiveStream();
    const resumeBoundaryRevision = stream.revision;
    stream = append(
      stream,
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("retained-after-gap-start"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Final reply after the gap.",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("retained-after-gap-delta"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Final reply after the gap.",
        complete: true,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("retained-after-gap-complete"),
      },
      {
        kind: "lifecycle",
        sessionId: "session-1",
        flavor: "terminal",
        status: "completed",
        text: "Done.",
        receivedAt: RECEIVED_AT,
        delivery: delivery("retained-after-gap-terminal"),
      },
    );

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map(),
      idlessTranscriptRun: {
        runStartRevision: 0,
        persistedAssistantTexts: [
          "Earlier reply persisted during the gap.",
          "Final reply after the gap.",
        ],
        persistedAssistantBoundaries: [
          {
            revision: resumeBoundaryRevision,
            persistedAssistantOrdinal: 1,
          },
        ],
      },
    });

    expect(reconciled.entries.filter(({ event }) => event.kind === "transcript")).toEqual([]);
  });

  it("applies a pending-complete boundary to an ID-less transcript that crosses it", () => {
    let stream = append(
      createHermesLiveStream(),
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("crossing-start"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Final reply crossing the resume boundary.",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("crossing-delta"),
      },
    );
    stream = recordHermesIdlessTranscriptPersistenceBoundary(stream, {
      runStartRevision: 0,
      persistedAssistantOrdinal: 1,
      pendingMessageComplete: true,
    });
    stream = append(
      stream,
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Final reply crossing the resume boundary.",
        complete: true,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("crossing-complete"),
      },
      {
        kind: "lifecycle",
        sessionId: "session-1",
        flavor: "terminal",
        status: "completed",
        text: "Done.",
        receivedAt: RECEIVED_AT,
        delivery: delivery("crossing-terminal"),
      },
    );

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map(),
      idlessTranscriptRun: {
        runStartRevision: 0,
        persistedAssistantTexts: [
          "Earlier assistant reply persisted during the gap.",
          "Final reply crossing the resume boundary.",
        ],
        persistedAssistantBoundaries: stream.idlessTranscriptPersistenceBoundaries,
      },
    });

    expect(reconciled.entries.filter(({ event }) => event.kind === "transcript")).toEqual([]);
  });

  it("does not shift a completed transcript at an ordinary full-prefix boundary", () => {
    let stream = append(
      createHermesLiveStream(),
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("pre-boundary-start"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Reply completed before the ordinary boundary.",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("pre-boundary-delta"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Reply completed before the ordinary boundary.",
        complete: true,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("pre-boundary-complete"),
      },
    );
    stream = recordHermesIdlessTranscriptPersistenceBoundary(stream, {
      runStartRevision: 0,
      persistedAssistantOrdinal: 1,
    });
    stream = append(stream, {
      kind: "lifecycle",
      sessionId: "session-1",
      flavor: "terminal",
      status: "completed",
      text: "Done.",
      receivedAt: RECEIVED_AT,
      delivery: delivery("pre-boundary-terminal"),
    });

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map(),
      idlessTranscriptRun: {
        runStartRevision: 0,
        persistedAssistantTexts: ["Reply completed before the ordinary boundary."],
        persistedAssistantBoundaries: stream.idlessTranscriptPersistenceBoundaries,
      },
    });

    expect(reconciled.entries.filter(({ event }) => event.kind === "transcript")).toEqual([]);
  });

  it("does not let identical pre-resume prose prove a later ID-less transcript persisted", () => {
    let stream = createHermesLiveStream();
    const resumeBoundaryRevision = stream.revision;
    stream = append(
      stream,
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("identical-after-gap-start"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Same reply.",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("identical-after-gap-delta"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Same reply.",
        complete: true,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("identical-after-gap-complete"),
      },
      {
        kind: "lifecycle",
        sessionId: "session-1",
        flavor: "terminal",
        status: "completed",
        text: "Done.",
        receivedAt: RECEIVED_AT,
        delivery: delivery("identical-after-gap-terminal"),
      },
    );

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map(),
      idlessTranscriptRun: {
        runStartRevision: 0,
        persistedAssistantTexts: ["Same reply."],
        persistedAssistantBoundaries: [
          {
            revision: resumeBoundaryRevision,
            persistedAssistantOrdinal: 1,
          },
        ],
      },
    });

    expect(reconciled).toBe(stream);
  });

  it.each([
    "Conflicting persisted reply.",
    "Complete live",
  ])("retains an ID-less transcript without monotonic persisted coverage: %s", (persistedAssistantText) => {
    const stream = append(
      createHermesLiveStream(),
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("idless-start"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Complete live reply.",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("idless-delta"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: "Complete live reply.",
        complete: true,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("idless-complete"),
      },
      {
        kind: "lifecycle",
        sessionId: "session-1",
        flavor: "terminal",
        status: "completed",
        text: "Done.",
        receivedAt: RECEIVED_AT,
        delivery: delivery("idless-terminal"),
      },
    );

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map(),
      idlessTranscriptRun: {
        runStartRevision: 0,
        persistedAssistantTexts: [persistedAssistantText],
      },
    });

    expect(reconciled).toBe(stream);
  });

  it("compacts a proven ID-less media-only completion by its transport text", () => {
    const mediaTransportText = "MEDIA:/tmp/idless-generated-result.png";
    const stream = append(
      createHermesLiveStream(),
      {
        kind: "transcript",
        sessionId: "session-1",
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("idless-media-start"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: mediaTransportText,
        complete: false,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("idless-media-delta"),
      },
      {
        kind: "transcript",
        sessionId: "session-1",
        delta: mediaTransportText,
        complete: true,
        failed: false,
        receivedAt: RECEIVED_AT,
        delivery: delivery("idless-media-complete"),
      },
      {
        kind: "lifecycle",
        sessionId: "session-1",
        flavor: "terminal",
        status: "completed",
        text: "Done.",
        receivedAt: RECEIVED_AT,
        delivery: delivery("idless-media-terminal"),
      },
    );

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map(),
      idlessTranscriptRun: {
        runStartRevision: 0,
        persistedAssistantTexts: [mediaTransportText],
      },
    });

    expect(reconciled.entries.filter(({ event }) => event.kind === "transcript")).toEqual([]);
  });

  it("normalizes media transport references before marking a message persisted", () => {
    const stream = append(
      createHermesLiveStream(),
      startEvent("media", "media-start"),
      deltaEvent("media", "Rendered result\nMEDIA:/tmp/generated-result.png", "media-delta"),
      completeEvent("media", "Rendered result\nMEDIA:/tmp/generated-result.png", "media-complete"),
    );

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map([["media", "Rendered result\n"]]),
    });

    expect(reconciled.persistedMessageIds).toEqual({ media: true });
  });

  it("marks a media-only message persisted after its transport reference is stripped", () => {
    const stream = append(
      createHermesLiveStream(),
      startEvent("media-only", "media-only-start"),
      deltaEvent("media-only", "MEDIA:/tmp/generated-result.mp4", "media-only-delta"),
      completeEvent("media-only", "MEDIA:/tmp/generated-result.mp4", "media-only-complete"),
    );

    const reconciled = reconcileHermesLiveStream(stream, {
      throughRevision: stream.revision,
      persistedMessages: new Map([["media-only", ""]]),
    });

    expect(reconciled.persistedMessageIds).toEqual({ "media-only": true });
  });
});
