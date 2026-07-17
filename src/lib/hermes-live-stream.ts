import type { JuneHermesEvent, PendingHermesAction } from "./hermes-control-plane";
import { stripRenderedMediaReferences, textFromHermesTransportContent } from "./agent-chat-runtime";

export type HermesLiveStream = {
  revision: number;
  entries: Array<{ event: JuneHermesEvent; revision: number }>;
  idlessTranscriptPersistenceBoundaries?: HermesIdlessTranscriptPersistenceBoundary[];
  seenDeliveries: HermesDeliveryLedger;
  transcriptByMessageId: Record<
    string,
    {
      complete: boolean;
      visibleLength: number;
      replayCandidate?: string;
      nextTextOffset?: number;
      pendingByTextOffset: Record<number, JuneHermesEvent>;
      pendingRevisionByTextOffset: Record<number, number>;
    }
  >;
  persistedMessageIds: Record<string, true>;
};

export type HermesIdlessTranscriptPersistenceBoundary = {
  runStartRevision: number;
  revision: number;
  persistedAssistantOrdinal: number;
  /** The runtime committed this assistant row atomically, but its ID-less
   * `message.complete` still belongs to the replacement transport. */
  pendingMessageComplete?: true;
};

type HermesDeliveryLedger = {
  root: DeliveryTrieNode;
  size: number;
};

type DeliveryTrieNode = {
  children?: Readonly<Record<number, DeliveryTrieNode>>;
  keys?: readonly string[];
};

type TranscriptEvent = Extract<JuneHermesEvent, { kind: "transcript" }>;
type TranscriptState = HermesLiveStream["transcriptByMessageId"][string];
type StreamEntry = HermesLiveStream["entries"][number];

export function createHermesLiveStream(): HermesLiveStream {
  return {
    revision: 0,
    entries: [],
    idlessTranscriptPersistenceBoundaries: [],
    seenDeliveries: { root: {}, size: 0 },
    transcriptByMessageId: {},
    persistedMessageIds: {},
  };
}

const MAX_IDLESS_TRANSCRIPT_PERSISTENCE_BOUNDARIES = 64;

/** Records how many content-bearing assistant rows from the accepted Agent run
 * were already persisted at an atomic live-resume boundary. An ordinary
 * boundary aligns later transcripts; pending-complete proof can also align the
 * active transcript whose final revision lands after the boundary. */
export function recordHermesIdlessTranscriptPersistenceBoundary(
  current: HermesLiveStream,
  options: {
    runStartRevision: number;
    persistedAssistantOrdinal: number;
    pendingMessageComplete?: boolean;
  },
): HermesLiveStream {
  if (
    !Number.isSafeInteger(options.runStartRevision) ||
    options.runStartRevision < 0 ||
    options.runStartRevision > current.revision ||
    !Number.isSafeInteger(options.persistedAssistantOrdinal) ||
    options.persistedAssistantOrdinal < 0
  ) {
    return current;
  }
  const boundaries = current.idlessTranscriptPersistenceBoundaries ?? [];
  const prior = boundaries.at(-1);
  const pendingMessageComplete = options.pendingMessageComplete === true;
  if (
    prior?.runStartRevision === options.runStartRevision &&
    prior.revision === current.revision &&
    Boolean(prior.pendingMessageComplete) === pendingMessageComplete
  ) {
    if (prior.persistedAssistantOrdinal >= options.persistedAssistantOrdinal) return current;
    return {
      ...current,
      idlessTranscriptPersistenceBoundaries: [
        ...boundaries.slice(0, -1),
        {
          runStartRevision: options.runStartRevision,
          revision: current.revision,
          persistedAssistantOrdinal: options.persistedAssistantOrdinal,
          ...(pendingMessageComplete ? { pendingMessageComplete: true as const } : {}),
        },
      ],
    };
  }
  return {
    ...current,
    idlessTranscriptPersistenceBoundaries: [
      ...boundaries,
      {
        runStartRevision: options.runStartRevision,
        revision: current.revision,
        persistedAssistantOrdinal: options.persistedAssistantOrdinal,
        ...(pendingMessageComplete ? { pendingMessageComplete: true as const } : {}),
      },
    ].slice(-MAX_IDLESS_TRANSCRIPT_PERSISTENCE_BOUNDARIES),
  };
}

/** June-owned identity for one approval request instance. Runtime-issued request ids
 * remain globally stable; payload fingerprints are scoped to the accepted Agent run. */
export function hermesApprovalInstanceId(
  action: PendingHermesAction,
  runStartRevision: number | undefined,
): string {
  if (action.kind === "approval" && action.instanceId) return action.instanceId;
  if (
    action.kind !== "approval" ||
    action.requestIdProvenance !== "payload-fingerprint" ||
    !Number.isSafeInteger(runStartRevision) ||
    (runStartRevision ?? -1) < 0
  ) {
    return action.requestId;
  }
  return `${action.requestId}\u0000run:${runStartRevision}`;
}

/** Returns the currently actionable instance for one raw approval id in the
 * semantic stream, respecting a payload fingerprint's Agent-run boundary. */
export function currentHermesApprovalInstanceId(
  stream: HermesLiveStream,
  requestId: string,
  runStartRevision: number | undefined,
): string | undefined {
  let pendingInstanceId: string | undefined;
  for (const { event, revision } of stream.entries) {
    if ((event.kind === "lifecycle" && event.flavor === "terminal") || event.kind === "error") {
      pendingInstanceId = undefined;
      continue;
    }
    if (
      (event.kind !== "pending_action" &&
        event.kind !== "pending_action_resolution" &&
        event.kind !== "pending_action_expiration") ||
      event.action.kind !== "approval" ||
      event.action.requestId !== requestId
    ) {
      continue;
    }
    if (event.kind === "pending_action") {
      if (
        event.action.requestIdProvenance === "payload-fingerprint" &&
        runStartRevision !== undefined &&
        revision <= runStartRevision
      ) {
        continue;
      }
      pendingInstanceId = hermesApprovalInstanceId(event.action, runStartRevision);
      continue;
    }
    if (!event.action.instanceId || event.action.instanceId === pendingInstanceId) {
      pendingInstanceId = undefined;
    }
  }
  return pendingInstanceId;
}

export function appendHermesLiveEvent(
  current: HermesLiveStream,
  event: JuneHermesEvent,
  options: { runStartRevision?: number } = {},
): HermesLiveStream {
  if (
    event.kind === "transcript" &&
    event.messageId &&
    current.transcriptByMessageId[event.messageId]?.complete
  ) {
    return current;
  }
  const scopedEvent = withApprovalInstance(current, event, options.runStartRevision);
  if (
    (scopedEvent.kind === "pending_action_resolution" ||
      scopedEvent.kind === "pending_action_expiration") &&
    scopedEvent.action.kind === "approval" &&
    !scopedEvent.action.instanceId
  ) {
    // A retirement without a currently actionable instance is stale replay,
    // not authority over a later request that happens to share its wire id.
    return current;
  }
  // Approval request ids are logical identities across reconnects. Once the
  // semantic stream has resolved, expired, or terminally closed one, reject a
  // fresh-delivery replay before callers can project it into pending-action,
  // activity, or status stores whose shorter bounded histories may be gone.
  if (isRetiredApprovalRequestReplay(current, scopedEvent, options.runStartRevision))
    return current;

  const deliveryKey = stableDeliveryKey(scopedEvent);
  if (deliveryKey && deliveryLedgerHas(current.seenDeliveries, deliveryKey)) return current;

  const next: HermesLiveStream = {
    revision: current.revision + 1,
    entries: [...current.entries],
    idlessTranscriptPersistenceBoundaries: current.idlessTranscriptPersistenceBoundaries ?? [],
    // A fixed-depth persistent hash trie keeps reducer snapshots immutable and
    // exact while adding/looking up delivery identities in effectively O(1).
    // Only the seven-node hash path is copied for an accepted delivery.
    seenDeliveries: deliveryKey
      ? addDeliveryKey(current.seenDeliveries, deliveryKey)
      : current.seenDeliveries,
    transcriptByMessageId: { ...current.transcriptByMessageId },
    persistedMessageIds: current.persistedMessageIds,
  };

  if (scopedEvent.kind === "transcript" && scopedEvent.messageId) {
    appendTranscriptEvent(next, scopedEvent);
  } else {
    appendSemanticEntry(next, scopedEvent, next.revision);
  }
  return next;
}

function withApprovalInstance(
  stream: HermesLiveStream,
  event: JuneHermesEvent,
  runStartRevision: number | undefined,
): JuneHermesEvent {
  if (event.kind === "pending_action" && event.action.kind === "approval") {
    const instanceId = hermesApprovalInstanceId(event.action, runStartRevision);
    return event.action.instanceId === instanceId
      ? event
      : { ...event, action: { ...event.action, instanceId } };
  }
  if (event.kind === "pending_action_resolution" && event.action.kind === "approval") {
    const instanceId =
      event.action.instanceId ??
      currentHermesApprovalInstanceId(stream, event.action.requestId, runStartRevision);
    return !instanceId || event.action.instanceId === instanceId
      ? event
      : { ...event, action: { ...event.action, instanceId } };
  }
  if (event.kind === "pending_action_expiration") {
    const instanceId =
      event.action.instanceId ??
      currentHermesApprovalInstanceId(stream, event.action.requestId, runStartRevision);
    return !instanceId || event.action.instanceId === instanceId
      ? event
      : { ...event, action: { ...event.action, instanceId } };
  }
  return event;
}

function isRetiredApprovalRequestReplay(
  stream: HermesLiveStream,
  candidate: JuneHermesEvent,
  runStartRevision: number | undefined,
): boolean {
  if (candidate.kind !== "pending_action" || candidate.action.kind !== "approval") return false;

  const requestId = candidate.action.requestId;
  // Old development/partial runtimes synthesize an approval identity from the
  // sanitized payload, so two real Agent runs can legitimately produce the
  // same id. Limit that compatibility identity to the current accepted run;
  // patched runtime-issued request ids remain sticky across Agent runs so
  // delayed replays stay shut.
  const revisionFloor =
    candidate.action.requestIdProvenance === "payload-fingerprint" ? runStartRevision : undefined;
  let state: "unseen" | "pending" | "retired" = "unseen";
  for (const { event, revision } of stream.entries) {
    if (revisionFloor !== undefined && revision <= revisionFloor) continue;
    if (
      state === "pending" &&
      ((event.kind === "lifecycle" && event.flavor === "terminal") || event.kind === "error")
    ) {
      state = "retired";
      continue;
    }
    if (
      (event.kind !== "pending_action" &&
        event.kind !== "pending_action_resolution" &&
        event.kind !== "pending_action_expiration") ||
      event.action.kind !== "approval" ||
      event.action.requestId !== requestId
    ) {
      continue;
    }
    if (event.kind === "pending_action") {
      if (state !== "retired") state = "pending";
    } else {
      state = "retired";
    }
  }
  return state === "retired";
}

export function hermesLiveEvents(current: HermesLiveStream): JuneHermesEvent[] {
  return current.entries.map(({ event }) => event);
}

export function reconcileHermesLiveStream(
  current: HermesLiveStream,
  options: {
    throughRevision: number;
    persistedMessages: ReadonlyMap<string, string>;
    idlessTranscriptRun?: {
      runStartRevision: number;
      persistedAssistantTexts: readonly string[];
      persistedAssistantBoundaries?: readonly Pick<
        HermesIdlessTranscriptPersistenceBoundary,
        "revision" | "persistedAssistantOrdinal" | "pendingMessageComplete"
      >[];
    };
  },
): HermesLiveStream {
  let persistedMessageIds: Record<string, true> | undefined;

  for (const [messageId, persistedText] of options.persistedMessages) {
    if (current.persistedMessageIds[messageId]) continue;
    const completeRevision = completedMessageRevision(current.entries, messageId);
    if (completeRevision === undefined || completeRevision > options.throughRevision) continue;
    if (!current.transcriptByMessageId[messageId]?.complete) continue;
    const liveText = stripRenderedMediaReferences(
      visibleTranscriptText(current.entries, messageId),
    );
    if (liveText !== stripRenderedMediaReferences(persistedText)) continue;

    persistedMessageIds ??= { ...current.persistedMessageIds };
    persistedMessageIds[messageId] = true;
  }

  const compactedIdlessTranscriptRevisions = options.idlessTranscriptRun
    ? persistedIdlessTranscriptRevisions(current.entries, {
        throughRevision: options.throughRevision,
        ...options.idlessTranscriptRun,
      })
    : undefined;
  if (!persistedMessageIds && !compactedIdlessTranscriptRevisions) return current;
  return {
    ...current,
    ...(compactedIdlessTranscriptRevisions
      ? {
          entries: current.entries.filter(
            ({ revision }) => !compactedIdlessTranscriptRevisions.has(revision),
          ),
        }
      : {}),
    // Identified canonical entries stay in place because their live part
    // boundaries are observable while mounted. The only removed entries are a
    // completed ID-less transcript proven equivalent to this run's persistence.
    persistedMessageIds: persistedMessageIds ?? current.persistedMessageIds,
  };
}

function persistedIdlessTranscriptRevisions(
  entries: readonly StreamEntry[],
  options: {
    runStartRevision: number;
    throughRevision: number;
    persistedAssistantTexts: readonly string[];
    persistedAssistantBoundaries?: readonly Pick<
      HermesIdlessTranscriptPersistenceBoundary,
      "revision" | "persistedAssistantOrdinal" | "pendingMessageComplete"
    >[];
  },
): Set<number> | undefined {
  if (
    !Number.isSafeInteger(options.runStartRevision) ||
    options.runStartRevision < 0 ||
    options.runStartRevision >= options.throughRevision
  ) {
    return undefined;
  }

  const completedTranscripts: Array<{ revisions: number[]; visibleText: string }> = [];
  let activeTranscript: { revisions: number[]; visibleText: string } | undefined;
  let terminalReached = false;

  for (const { event, revision } of entries) {
    if (revision <= options.runStartRevision || revision > options.throughRevision) continue;
    if (event.kind === "lifecycle" && event.flavor === "terminal") {
      if (activeTranscript) return undefined;
      terminalReached = true;
      continue;
    }
    if (event.kind !== "transcript") continue;
    // A transcript after the terminal belongs to a later Agent run, while an
    // explicit id needs the existing id-based reconciliation path. In either
    // case this proof is not exclusively about one completed ID-less run.
    if (terminalReached || event.messageId) return undefined;
    if (event.failed) return undefined;

    const startsTranscript = !event.complete && event.delta === undefined;
    if (startsTranscript) {
      if (activeTranscript) return undefined;
      activeTranscript = { revisions: [revision], visibleText: "" };
      continue;
    }

    activeTranscript ??= { revisions: [], visibleText: "" };
    activeTranscript.revisions.push(revision);
    const text = event.delta ?? "";
    if (!event.complete) {
      activeTranscript.visibleText += text;
      continue;
    }
    // Hermes completes with a full snapshot. Accept only its monotonic suffix;
    // the renderer likewise preserves already-painted text on a conflicting
    // snapshot, so this reconstructs the exact visible live transcript.
    if (text.startsWith(activeTranscript.visibleText)) {
      activeTranscript.visibleText = text;
    }
    completedTranscripts.push(activeTranscript);
    activeTranscript = undefined;
  }

  if (!terminalReached || activeTranscript || completedTranscripts.length === 0) return undefined;
  if (options.persistedAssistantTexts.length < completedTranscripts.length) return undefined;
  const persistedAssistantBoundaries = options.persistedAssistantBoundaries ?? [];
  let priorBoundaryRevision = options.runStartRevision;
  for (const boundary of persistedAssistantBoundaries) {
    if (
      !Number.isSafeInteger(boundary.revision) ||
      boundary.revision < options.runStartRevision ||
      boundary.revision > options.throughRevision ||
      boundary.revision < priorBoundaryRevision ||
      !Number.isSafeInteger(boundary.persistedAssistantOrdinal) ||
      boundary.persistedAssistantOrdinal < 0
    ) {
      return undefined;
    }
    priorBoundaryRevision = boundary.revision;
  }

  const appliedBoundaryIndexes = new Set<number>();
  let persistedAssistantOrdinal = 0;
  for (const transcript of completedTranscripts) {
    const firstRevision = transcript.revisions[0];
    const lastRevision = transcript.revisions.at(-1);
    if (firstRevision === undefined || lastRevision === undefined) return undefined;
    for (
      let boundaryIndex = 0;
      boundaryIndex < persistedAssistantBoundaries.length;
      boundaryIndex += 1
    ) {
      if (appliedBoundaryIndexes.has(boundaryIndex)) continue;
      const boundary = persistedAssistantBoundaries[boundaryIndex];
      if (!boundary) continue;
      // A full-prefix snapshot cannot reinterpret a transcript already in
      // progress. The pending-complete marker is narrower authority: it proves
      // that this exact assistant row was committed while its completion frame
      // still belongs after the atomic resume boundary.
      const precedesTranscript = boundary.revision < firstRevision;
      const provesCrossingCompletion =
        boundary.pendingMessageComplete === true && boundary.revision < lastRevision;
      if (!precedesTranscript && !provesCrossingCompletion) continue;
      persistedAssistantOrdinal = Math.max(
        persistedAssistantOrdinal,
        boundary.persistedAssistantOrdinal,
      );
      appliedBoundaryIndexes.add(boundaryIndex);
    }
    const visibleText = textFromHermesTransportContent(transcript.visibleText) ?? "";
    const persistedText =
      textFromHermesTransportContent(
        options.persistedAssistantTexts[persistedAssistantOrdinal] ?? "",
      ) ?? "";
    if (!visibleText || !persistedText.startsWith(visibleText)) return undefined;
    persistedAssistantOrdinal += 1;
  }

  return new Set(completedTranscripts.flatMap((transcript) => transcript.revisions));
}

/** Reconciles the assistant text captured atomically by `session.resume` with
 * June's already-visible live transcript. The snapshot is only authoritative
 * for a monotonic suffix: an equal, shorter, or conflicting value cannot
 * rewrite text the user has already seen. */
export function reconcileHermesInflightSnapshot(
  current: HermesLiveStream,
  options: {
    storedSessionId: string;
    assistant: string;
    receivedAt: string;
    /** A live resume can begin streaming entirely while no Workspace owns the
     * transport. In that case the atomic in-flight snapshot is the only start
     * edge June can recover, so seed a pinned ID-less assistant transcript. */
    bootstrapIfMissing?: boolean;
  },
): HermesLiveStream {
  const openTranscript = openAssistantTranscript(current.entries, options.storedSessionId);
  if (!openTranscript) {
    if (!options.bootstrapIfMissing || !options.assistant) return current;
    const started = appendHermesLiveEvent(current, {
      kind: "transcript",
      sessionId: options.storedSessionId,
      complete: false,
      failed: false,
      role: "assistant",
      receivedAt: options.receivedAt,
    });
    return appendHermesLiveEvent(started, {
      kind: "transcript",
      sessionId: options.storedSessionId,
      delta: options.assistant,
      complete: false,
      failed: false,
      role: "assistant",
      receivedAt: options.receivedAt,
    });
  }
  if (!options.assistant.startsWith(openTranscript.visibleText)) return current;

  const suffix = options.assistant.slice(openTranscript.visibleText.length);
  if (!suffix) return current;

  return appendHermesLiveEvent(current, {
    kind: "transcript",
    sessionId: options.storedSessionId,
    ...(openTranscript.messageId === undefined ? {} : { messageId: openTranscript.messageId }),
    delta: suffix,
    complete: false,
    failed: false,
    receivedAt: options.receivedAt,
  });
}

function openAssistantTranscript(entries: StreamEntry[], storedSessionId: string) {
  let active:
    | {
        messageId?: string;
        isAssistant: boolean;
        visibleText: string;
      }
    | undefined;

  for (const { event } of entries) {
    if (!("sessionId" in event) || event.sessionId !== storedSessionId) continue;
    if (event.kind === "error" || (event.kind === "lifecycle" && event.flavor === "terminal")) {
      active = undefined;
      continue;
    }
    if (event.kind !== "transcript") continue;

    const sameTranscript = active !== undefined && active.messageId === event.messageId;
    if (event.complete === true) {
      if (sameTranscript) active = undefined;
      continue;
    }

    if (event.delta === undefined) {
      if (!sameTranscript) {
        active = {
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          isAssistant: event.role !== "user" && event.role !== "system",
          visibleText: "",
        };
      }
      continue;
    }

    if (!sameTranscript) {
      active = {
        ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
        isAssistant: event.role !== "user" && event.role !== "system",
        visibleText: "",
      };
    }
    if (active?.isAssistant) active.visibleText += event.delta;
  }

  return active?.isAssistant ? active : undefined;
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
        pendingRevisionByTextOffset: { ...existing.pendingRevisionByTextOffset },
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
        pendingRevisionByTextOffset: { ...existing.pendingRevisionByTextOffset },
      }
    : emptyTranscriptState();
  if (state.complete) return;

  if (event.complete === true) {
    const baseline = visibleTranscriptText(stream.entries, messageId);
    const snapshot = event.delta ?? "";
    const monotonicText = snapshot.startsWith(baseline) ? snapshot : baseline;
    const suffix = monotonicText.slice(baseline.length);
    const pendingRevisions = Object.values(state.pendingRevisionByTextOffset);
    if (suffix && pendingRevisions.length > 0) {
      insertSemanticEntryAtRevision(
        stream,
        { ...event, complete: false, failed: false, delta: suffix },
        stream.revision,
        Math.min(...pendingRevisions),
      );
    }
    appendSemanticEntry(stream, { ...event, delta: monotonicText }, stream.revision);
    stream.transcriptByMessageId[messageId] = {
      complete: true,
      visibleLength: monotonicText.length,
      pendingByTextOffset: {},
      pendingRevisionByTextOffset: {},
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
  if (state.pendingByTextOffset[textOffset] === undefined) {
    state.pendingByTextOffset[textOffset] = event;
    state.pendingRevisionByTextOffset[textOffset] = stream.revision;
  }

  let virtualText = visibleTranscriptText(stream.entries, messageId);
  let appendedText = "";
  let appendedEvent: TranscriptEvent | undefined;
  let earliestRevision: number | undefined;
  let flushed = true;
  while (flushed) {
    flushed = false;
    const pendingOffsets = Object.keys(state.pendingByTextOffset)
      .map(Number)
      .filter((offset) => offset <= virtualText.length)
      .sort((left, right) => left - right);

    for (const pendingOffset of pendingOffsets) {
      const pending = state.pendingByTextOffset[pendingOffset];
      if (pending?.kind !== "transcript") continue;
      const suffix = verifiedOffsetSuffix(virtualText, pending.delta ?? "", pendingOffset);
      if (suffix === undefined) {
        // This offset is already inside monotonic visible text, so a mismatch
        // can never become valid later. Keeping its old revision would let it
        // drag unrelated future text ahead of interleaved semantic activity.
        delete state.pendingByTextOffset[pendingOffset];
        delete state.pendingRevisionByTextOffset[pendingOffset];
        continue;
      }

      virtualText += suffix;
      if (suffix) {
        appendedText += suffix;
        appendedEvent = pending;
        const pendingRevision = state.pendingRevisionByTextOffset[pendingOffset] ?? stream.revision;
        earliestRevision =
          earliestRevision === undefined
            ? pendingRevision
            : Math.min(earliestRevision, pendingRevision);
      }
      delete state.pendingByTextOffset[pendingOffset];
      delete state.pendingRevisionByTextOffset[pendingOffset];
      flushed = true;
    }
  }

  if (appendedText && appendedEvent && earliestRevision !== undefined) {
    const pendingRevisions = Object.values(state.pendingRevisionByTextOffset);
    const orderingRevision =
      pendingRevisions.length > 0
        ? Math.min(earliestRevision, ...pendingRevisions)
        : earliestRevision;
    insertSemanticEntryAtRevision(
      stream,
      { ...appendedEvent, delta: appendedText },
      stream.revision,
      orderingRevision,
    );
  }

  state.visibleLength = virtualText.length;
  state.nextTextOffset = state.visibleLength;
}

function verifiedOffsetSuffix(
  visibleText: string,
  delta: string,
  textOffset: number,
): string | undefined {
  if (textOffset > visibleText.length) return undefined;

  const overlapLength = Math.min(delta.length, Math.max(visibleText.length - textOffset, 0));
  if (visibleText.slice(textOffset, textOffset + overlapLength) !== delta.slice(0, overlapLength)) {
    return undefined;
  }

  return delta.slice(Math.max(visibleText.length - textOffset, 0));
}

function insertSemanticEntryAtRevision(
  stream: HermesLiveStream,
  event: TranscriptEvent,
  revision: number,
  orderingRevision: number,
) {
  const insertionIndex = stream.entries.findIndex(
    ({ event: existing, revision: existingRevision }) => {
      if (existingRevision <= orderingRevision) return false;
      return !(
        existing.kind === "transcript" &&
        existing.complete !== true &&
        existing.messageId === event.messageId &&
        existing.delta !== undefined
      );
    },
  );

  if (insertionIndex < 0) {
    appendSemanticEntry(stream, event, revision);
    return;
  }

  const previous = stream.entries[insertionIndex - 1];
  if (previous?.event.kind === "transcript" && canCoalesceTranscript(previous.event, event)) {
    stream.entries[insertionIndex - 1] = {
      event: {
        ...event,
        delta: (previous.event.delta ?? "") + (event.delta ?? ""),
      },
      revision,
    };
    return;
  }

  stream.entries.splice(insertionIndex, 0, { event, revision });
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

function deliveryLedgerHas(ledger: HermesDeliveryLedger, key: string) {
  const hash = stableStringHash(key);
  let node: DeliveryTrieNode | undefined = ledger.root;
  for (let depth = 0; depth < 7; depth += 1) {
    node = node.children?.[deliveryTrieSlot(hash, depth)];
    if (!node) return false;
  }
  return node.keys?.includes(key) === true;
}

function addDeliveryKey(ledger: HermesDeliveryLedger, key: string): HermesDeliveryLedger {
  return {
    root: addDeliveryTrieKey(ledger.root, stableStringHash(key), key, 0),
    size: ledger.size + 1,
  };
}

function addDeliveryTrieKey(
  node: DeliveryTrieNode,
  hash: number,
  key: string,
  depth: number,
): DeliveryTrieNode {
  if (depth === 7) {
    return { ...node, keys: [...(node.keys ?? []), key] };
  }
  const slot = deliveryTrieSlot(hash, depth);
  const child = node.children?.[slot] ?? {};
  return {
    ...node,
    children: {
      ...node.children,
      [slot]: addDeliveryTrieKey(child, hash, key, depth + 1),
    },
  };
}

function deliveryTrieSlot(hash: number, depth: number) {
  return (hash >>> (depth * 5)) & 31;
}

function stableStringHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function emptyTranscriptState(): TranscriptState {
  return {
    complete: false,
    visibleLength: 0,
    pendingByTextOffset: {},
    pendingRevisionByTextOffset: {},
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
