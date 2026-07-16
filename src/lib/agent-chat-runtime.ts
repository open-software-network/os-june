import type {
  AgentMessageDto,
  AgentToolEventDto,
  AgentToolEventStatus,
  HermesSessionMessage,
} from "./tauri";
import {
  isContextOverflowErrorSentinel,
  isContextOverflowMessage,
  isInsufficientCreditsMessage,
} from "./errors";
import { isScheduledRunPreamble, stripScheduledRunPreamble } from "./hermes-adapter";
import { displayedUserMessageText } from "./issue-report-prompt";
import { displayedSkillInvocationText } from "./skill-slash-commands";
import type { JuneHermesEvent } from "./hermes-control-plane";
import { generatedMediaToolKind, toolActivityLabel } from "./agent-tool-labels";
import { stripProjectContext } from "./agent-project-context";

export type AgentChatTextPart = {
  type: "text";
  text: string;
  status?: "running" | "complete";
  /** Stable semantic segment identity for live Hermes transcript prose. */
  renderKey?: string;
};

export type AgentChatReasoningPart = {
  type: "reasoning";
  text: string;
  status: "running" | "complete";
  /** Stable semantic segment identity for live Hermes reasoning. */
  renderKey?: string;
};

export type AgentChatContextPart = {
  type: "context";
  text: string;
  preview: string;
  status: "complete";
};

export type AgentChatToolPart = {
  type: "tool";
  id: string;
  name: string;
  text: string;
  status: "running" | "complete" | "failed";
  /** Set when the call is expected to produce media (an image/video generation
   * tool), so the turn can hold space with a generation placeholder while the
   * part is running and let the inline result own the completed state. */
  media?: "image" | "video";
};

export type AgentApprovalChoice = "once" | "session" | "always" | "deny";

export type AgentChatApprovalPart = {
  type: "approval";
  id: string;
  /** June-owned instance identity; Hermes responses still use `id`. */
  instanceId?: string;
  sessionId?: string;
  command: string;
  description: string;
  allowPermanent: boolean;
  choice?: AgentApprovalChoice;
  status: "pending" | "resolved" | "expired";
  retiredReason?: string;
};

export type AgentChatClarifyPart = {
  type: "clarify";
  id: string;
  sessionId?: string;
  question: string;
  choices: string[];
  answer?: string;
  status: "pending" | "resolved";
};

/** A privilege-escalation (`sudo.request`) the agent is blocked on until the
 * user explicitly approves or denies. `command`/`reason`/`mode` are optional —
 * Hermes may omit any of them, so the card still renders an approve/deny prompt
 * when they're absent. `approved` records the resolution for a revisited
 * transcript. */
export type AgentChatSudoPart = {
  type: "sudo";
  id: string;
  sessionId?: string;
  command?: string;
  reason?: string;
  mode?: "sandboxed" | "unrestricted";
  approved?: boolean;
  status: "pending" | "resolved";
};

/** A `secret.request` the agent is blocked on until the user provides a value.
 * This part NEVER carries the secret value — only the metadata about which
 * secret is wanted (`keyName`) and an optional `reason`. The entered value
 * lives transiently in the input component and is sent straight to the gateway,
 * never onto a part, the turn tree, or any export. */
export type AgentChatSecretPart = {
  type: "secret";
  id: string;
  sessionId?: string;
  keyName?: string;
  reason?: string;
  status: "pending" | "resolved";
};

/** A turn-level condition the user can act on, rendered as a notice card
 * instead of raw error text: `credits` (the balance ran out) or
 * `context-overflow` (the request outgrew the model's context / the agent
 * request-size limit and cannot be retried as-is — JUN-169). */
export type AgentChatNoticePart = {
  type: "notice";
  kind: "credits" | "context-overflow";
  text: string;
};

/** A mid-run instruction the user steered into a still-working session (feature
 * 06), rendered as a quiet "Steering" system item so the transcript records
 * what the user redirected June toward. It carries only the instruction text —
 * the gateway ack is not part of the transcript. */
export type AgentChatSteeringPart = {
  type: "steering";
  text: string;
};

/** A built-in image generation result (the `/image` slash command). It lives as
 * an assistant part so the generated image renders inline in the thread — with
 * its own loader and error states — instead of being dropped into the composer
 * as an attachment chip. `dataUrl` is the inline preview shown directly; `path`
 * is the imported workspace file the open/download affordances reuse (the same
 * bridge file flow as any other artifact). Synthesized client-side: it never
 * comes off the gateway message stream, so it carries its bytes inline. */
export type AgentChatImagePart = {
  type: "image";
  status: "running" | "complete" | "error";
  /** The prompt the user typed after `/image`. */
  prompt: string;
  /** Stable June API replay key for this logical `/image` turn. */
  requestId?: string;
  /** Image model pinned at turn creation. A retry must replay the exact
   * request shape June API hashed into the replay-ledger key, so a settings
   * change between attempt and retry cannot become a second charge. */
  model?: string;
  /** Safe-mode value pinned at turn creation; same replay-shape reason. */
  safeMode?: boolean;
  /** Original synthetic user-turn timestamp, kept so retry can finish the same turn. */
  userCreatedAt?: string;
  /** Original synthetic assistant-turn timestamp, kept so retry can finish the same turn. */
  imageCreatedAt?: string;
  /** Imported workspace path; set once `status === "complete"`. */
  path?: string;
  /** `data:<mime>;base64,…` for the inline preview; set when complete. */
  dataUrl?: string;
  /** Display name of the imported file; set when complete. */
  name?: string;
  /** User-facing failure message; set when `status === "error"`. */
  error?: string;
};

export type AgentChatVideoPart = {
  type: "video";
  status: "running" | "complete" | "error";
  /** The prompt that produced the video. */
  prompt: string;
  /** Stable June API replay key for this logical `/video` turn. */
  requestId?: string;
  /** Video model pinned at turn creation for replay-shape stability. */
  model?: string;
  /** Original synthetic user-turn timestamp, kept so retry can finish the same turn. */
  userCreatedAt?: string;
  /** Original synthetic assistant-turn timestamp, kept so retry can finish the same turn. */
  videoCreatedAt?: string;
  /** June API video job id, set once queueing succeeds. */
  jobId?: string;
  /** Last processing progress from the status poll. */
  averageExecutionMs?: number;
  executionMs?: number;
  /** Local mp4 path; set once `status === "complete"`. */
  path?: string;
  /** Optional poster preview, reserved for future June API support. */
  posterDataUrl?: string;
  /** Display name of the local video file; set when complete. */
  name?: string;
  /** User-facing failure message; set when `status === "error"`. */
  error?: string;
};

export type AgentChatPart =
  | AgentChatTextPart
  | AgentChatReasoningPart
  | AgentChatContextPart
  | AgentChatToolPart
  | AgentChatApprovalPart
  | AgentChatClarifyPart
  | AgentChatSudoPart
  | AgentChatSecretPart
  | AgentChatNoticePart
  | AgentChatSteeringPart
  | AgentChatImagePart
  | AgentChatVideoPart;

export type AgentChatTurn = {
  id: string;
  /** Persisted Hermes message id to fork from. Synthetic/live rows keep this
   * unset so the workspace can resolve them to the nearest saved branch point. */
  branchMessageId?: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  status: "running" | "complete";
  parts: AgentChatPart[];
  /** True for the opening prompt of a scheduled-routine run — the UI labels it
   * so a cron run reads as a routine rather than a message the user sent. */
  isScheduledRun?: boolean;
};

const MEDIA_IMAGE_EXTENSION_PATTERN = "png|jpe?g|gif|webp|tiff?|bmp|avif";
// A Hermes MEDIA reference is either an absolute path
// (`MEDIA:/…/image_cache/img.png`, which can contain spaces like "Application
// Support") or a bare filename (`MEDIA:img_ae9ed1ffc669.png`) — the model
// commonly echoes just the `filename` the june_image tool returned rather than
// a full path. The bare form uses a filename-safe charset (no slash, no space)
// so it can't swallow surrounding prose; the absolute form stays permissive.
// The backend (validate_hermes_file_path) resolves a bare filename against the
// generated-image roots before loading it.
const MEDIA_IMAGE_REFERENCE_PATTERN = new RegExp(
  `MEDIA:((?:/[^\\r\\n]+?|[A-Za-z0-9._-]+?)\\.(?:${MEDIA_IMAGE_EXTENSION_PATTERN}))(?:[)\\].,;:]?)(?=\\s|$)`,
  "gi",
);
const mediaImageReferencePattern = () =>
  new RegExp(MEDIA_IMAGE_REFERENCE_PATTERN.source, MEDIA_IMAGE_REFERENCE_PATTERN.flags);
const MEDIA_VIDEO_EXTENSION_PATTERN = "mp4|mov|webm|m4v";
// Matches an absolute MEDIA path OR a bare June generated-video filename
// (`generated-video-<hex>.mp4`). The agent often refers to a finished video by
// filename only — especially when asked to show it again after a tool call
// that timed out — and localVideoFileSrc resolves bare names against the
// generated-videos dir. The bare alternative is pinned to June's own naming so
// it can't swallow arbitrary prose.
const MEDIA_VIDEO_REFERENCE_PATTERN = new RegExp(
  `MEDIA:((?:/[^\\r\\n]+?|generated-video-[0-9a-f]+)\\.(?:${MEDIA_VIDEO_EXTENSION_PATTERN}))(?:[)\\].,;:]?)(?=\\s|$)`,
  "gi",
);
export const mediaVideoReferencePattern = () =>
  new RegExp(MEDIA_VIDEO_REFERENCE_PATTERN.source, MEDIA_VIDEO_REFERENCE_PATTERN.flags);

function sortAgentChatTurns(turns: AgentChatTurn[]) {
  return turns
    .map((turn, index) => ({ turn, index }))
    .sort((a, b) => a.turn.createdAt.localeCompare(b.turn.createdAt) || a.index - b.index)
    .map(({ turn }) => turn);
}

export function buildAgentChatTurns(
  messages: AgentMessageDto[],
  toolEvents: AgentToolEventDto[],
  liveEvents: JuneHermesEvent[] = [],
): AgentChatTurn[] {
  const turns = messages.map(messageToTurn);
  appendPersistedToolEvents(turns, toolEvents);
  appendLiveHermesEvents(turns, liveEvents);
  return sortAgentChatTurns(
    turns.filter((turn) =>
      turn.parts.some((part) => part.type === "tool" || partText(part).trim()),
    ),
  );
}

export function buildHermesSessionChatTurns(
  messages: HermesSessionMessage[],
  liveEvents: JuneHermesEvent[] = [],
  syntheticTurns: AgentChatTurn[] = [],
): AgentChatTurn[] {
  const turns: AgentChatTurn[] = [];
  const toolResults = new Map<string, HermesSessionMessage>();
  const persistedToolResultIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "tool") {
      const id = message.tool_call_id ?? message.id;
      persistedToolResultIds.add(id);
      toolResults.set(id, message);
      const turn =
        lastAssistantTurn(turns) ?? createAssistantTurn(turns, messageTimestamp(message));
      upsertToolPart(turn.parts, {
        id,
        name: toolActivityLabel(message.tool_name ?? undefined),
        text: textFromHermesContent(message.content) ?? "",
        status: "complete",
        media: generatedMediaToolKind(message.tool_name ?? undefined),
      });
      // Media tool results render inline so they show in-thread instead of
      // being lost to the collapsed tool row. Image base64 and MEDIA refs are
      // stripped from the tool text above.
      appendImageParts(turn.parts, imagePartsFromHermesContent(message.content));
      appendVideoParts(turn.parts, videoPartsFromHermesContent(message.content));
      turn.status = "complete";
      continue;
    }

    const content = displayContentForHermesMessage(message);
    const messageImageParts =
      message.role === "assistant" ? imagePartsFromHermesContent(message.content) : [];
    const messageVideoParts =
      message.role === "assistant" ? videoPartsFromHermesContent(message.content) : [];
    const contextPart = content ? contextCompactionPartForHermesContent(content) : undefined;

    const turn: AgentChatTurn = {
      id: message.id,
      branchMessageId: message.id,
      role: contextPart
        ? "system"
        : message.role === "assistant"
          ? "assistant"
          : message.role === "system"
            ? "system"
            : "user",
      createdAt: messageTimestamp(message),
      status: "complete",
      parts: [],
      isScheduledRun: isScheduledRunMessage(message) || undefined,
    };

    if (contextPart) {
      turn.parts.push(contextPart);
    } else {
      const reasoning =
        stringValue(message.reasoning, true) ??
        stringValue(message.reasoning_content, true) ??
        textFromHermesContent(message.reasoning_details);
      if (reasoning) {
        turn.parts.push({
          type: "reasoning",
          text: reasoning,
          status: "complete",
        });
      }

      for (const call of parseToolCalls(message.tool_calls)) {
        const result = toolResults.get(call.id);
        const media = generatedMediaToolKind(call.name, call.arguments);
        turn.parts.push({
          type: "tool",
          id: call.id,
          name: toolActivityLabel(call.name, call.arguments),
          text: textFromHermesContent(result?.content) ?? stringifyObject(call.arguments) ?? "",
          status: "complete",
          ...(media ? { media } : {}),
        });
      }

      if (content) {
        const notice =
          turn.role === "assistant"
            ? (creditsNoticeFromTurnText(content) ?? persistedContextOverflowNotice(content))
            : undefined;
        turn.parts.push(
          notice ?? {
            type: "text",
            text: content,
            status: "complete",
          },
        );
      }
      if (!contextPart && turn.role === "assistant") {
        appendImageParts(turn.parts, messageImageParts);
        appendVideoParts(turn.parts, messageVideoParts);
      }
    }

    if (turn.parts.length) {
      turns.push(turn);
    }
  }

  appendLiveHermesEvents(turns, liveEvents, syntheticTurns, persistedToolResultIds);
  const sortedTurns = sortAgentChatTurns(turns);
  deduplicateGeneratedMediaWithinAgentRuns(sortedTurns);
  return sortedTurns.filter((turn) =>
    turn.parts.some((part) => part.type === "tool" || partText(part).trim()),
  );
}

// Contraction/possessive enclitics the gateway tokenizes as their own chunk
// (`'s`, `'re`, `'t`, …). When it reassembles a streamed message for storage
// it strips the leading space off the chunk that follows one, so the next
// word glues on: "it's not" persists as "it'snot", "Mac's camera" as
// "Mac'scamera". The damage is in the persisted text and survives reloads, so
// monotonic live-stream reconciliation deliberately never rewrites it, so this
// repairs persisted/history prose at display time.
const CONTRACTION_GLUE = /([A-Za-z])('(?:s|re|ve|ll|m|d|t))(?=[A-Za-z])/gi;

/**
 * Re-inserts the space a gateway streaming-reassembly bug drops after a
 * contraction or possessive ("it'snot" -> "it's not"). Pure and idempotent:
 * already-spaced text has no match. Deliberately conservative — it skips an
 * apostrophe preceded by "s" so a plural possessive glued to the next word
 * ("kids'toys") is left untouched rather than mis-split into "kids't oys".
 * Apply only to assistant prose (never code spans, URLs, or user text).
 */
export function repairContractionSpacing(text: string): string {
  return text.replace(CONTRACTION_GLUE, (whole, pre: string, enclitic: string) =>
    pre.toLowerCase() === "s" ? whole : `${pre}${enclitic} `,
  );
}

export function completedHermesMessageText(events: JuneHermesEvent[]) {
  const turn = buildAgentChatTurns([], [], events)
    .filter((item) => item.role === "assistant")
    .at(-1);
  const holdTrailingMediaTransport = Boolean(
    turn?.parts.some(
      (part) =>
        part.type === "image" ||
        part.type === "video" ||
        (part.type === "tool" && part.media !== undefined),
    ),
  );
  const text = turn?.parts
    .filter((part): part is AgentChatTextPart => part.type === "text")
    .map((part) => stripRenderedMediaReferences(part.text, holdTrailingMediaTransport))
    .join("")
    .trim();
  return turn?.status === "complete" ? (text ?? "") : "";
}

// A turn that died on a billing failure reaches us as the raw provider error
// ("Error: Error code: 402 - {... 'insufficient_credits'}") — persisted as the
// assistant's text, or carried by a live error/message.complete event. Surface
// it as a first-class notice instead of leaking the raw error string.
function creditsNotice(text: string): AgentChatNoticePart | undefined {
  return isInsufficientCreditsMessage(text) ? { type: "notice", kind: "credits", text } : undefined;
}

// A turn that died because the request outgrew the model's context (or the
// agent request-size limit) reaches us as a raw provider/gateway error
// ("Context length exceeded (…). Cannot compress further.", "prompt_too_long
// …maximum context length"). Surface it as a first-class notice — on a single
// oversized turn there is nothing to compress, so retrying as-is only loops
// (JUN-169). Unlike a billing failure the wording never starts with "Error:",
// so this matches the overflow phrases anywhere in the text.
function contextOverflowNotice(text: string): AgentChatNoticePart | undefined {
  return isContextOverflowMessage(text)
    ? { type: "notice", kind: "context-overflow", text }
    : undefined;
}

// Persisted/reloaded turns carry no failure flag (the stored message has no
// status field), so only the unambiguous error sentinels may fold. An ordinary
// saved answer that discusses "the maximum context length" must stay text, not
// reload as a notice that drops the real answer (JUN-169). Mirrors the credits
// path's reliance on the "Error:" text prefix for the same persisted case.
function persistedContextOverflowNotice(text: string): AgentChatNoticePart | undefined {
  return isContextOverflowErrorSentinel(text)
    ? { type: "notice", kind: "context-overflow", text }
    : undefined;
}

// Resolve the most specific actionable notice for a failed turn's text: a
// billing failure first (most specific), then a context overflow.
function turnNotice(text: string): AgentChatNoticePart | undefined {
  return creditsNotice(text) ?? contextOverflowNotice(text);
}

// Assistant text only counts as a billing failure when it's the runtime's
// error sentinel ("Error: <provider error>") — June talking *about* credits in
// prose must stay ordinary text.
function creditsNoticeFromTurnText(text: string): AgentChatNoticePart | undefined {
  return /^\s*error\b/i.test(text) ? creditsNotice(text) : undefined;
}

function messageToTurn(message: AgentMessageDto): AgentChatTurn {
  const notice =
    message.role === "assistant"
      ? (creditsNoticeFromTurnText(message.content) ??
        persistedContextOverflowNotice(message.content))
      : undefined;
  return {
    id: message.id,
    role:
      message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
    createdAt: message.createdAt,
    status: "complete",
    parts: [notice ?? { type: "text", text: message.content, status: "complete" }],
  };
}

function appendPersistedToolEvents(turns: AgentChatTurn[], toolEvents: AgentToolEventDto[]) {
  // A single synthetic turn that collects events newer than every persisted
  // assistant message (an in-flight turn that has not been persisted yet).
  let trailingTurn: AgentChatTurn | undefined;
  for (const event of toolEvents) {
    const status = toolStatus(event.status);
    let turn: AgentChatTurn | undefined;
    if (event.createdAt) {
      turn = assistantTurnForTimestamp(turns, event.createdAt);
      if (!turn) {
        trailingTurn ??= createAssistantTurn(turns, event.createdAt);
        turn = trailingTurn;
      }
    } else {
      turn = lastAssistantTurn(turns);
      if (!turn) {
        trailingTurn ??= createAssistantTurn(turns, event.createdAt);
        turn = trailingTurn;
      }
    }
    upsertToolPart(turn.parts, {
      id: event.id,
      name: event.toolName,
      text: event.summary,
      status,
    });
    if (turn === trailingTurn) {
      turn.status = status === "running" ? "running" : "complete";
    }
  }
}

function assistantTurnForTimestamp(turns: AgentChatTurn[], createdAt: string | undefined) {
  if (!createdAt) return undefined;
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    if (turn.createdAt >= createdAt) return turn;
  }
  return undefined;
}

function appendLiveHermesEvents(
  turns: AgentChatTurn[],
  events: JuneHermesEvent[],
  syntheticTurns: AgentChatTurn[] = [],
  persistedToolResultIds: ReadonlySet<string> = new Set(),
) {
  let currentAssistant: AgentChatTurn | null = null;
  let transcriptOwnerMessageId: string | undefined;
  let idlessToolSequence = 0;
  const toolCreatedTurns = new Set<AgentChatTurn>();
  const completedMessageIds = new Set<string>();
  const liveAssistantTurnsByMessageId = new Map<string, AgentChatTurn>();
  const messageIdByTurn = new Map<AgentChatTurn, string>();
  const persistedTurnForLiveTurn = new Map<AgentChatTurn, AgentChatTurn>();
  const persistedAssistantTurnsByMessageId = new Map(
    turns
      .filter(
        (turn): turn is AgentChatTurn & { branchMessageId: string } =>
          turn.role === "assistant" && turn.branchMessageId !== undefined,
      )
      .map((turn) => [turn.branchMessageId, turn] as const),
  );
  const pendingSyntheticTurns = sortAgentChatTurns(
    syntheticTurns.map((turn) => ({
      ...turn,
      parts: [...turn.parts],
    })),
  );

  const identifiedAssistantTurn = (messageId: string, receivedAt: string) => {
    const existing = liveAssistantTurnsByMessageId.get(messageId);
    if (existing) return existing;

    const persisted = persistedAssistantTurnsByMessageId.get(messageId);
    if (persisted) {
      const persistedIndex = turns.indexOf(persisted);
      if (persistedIndex >= 0) turns.splice(persistedIndex, 1);
    }

    const turn = createAssistantTurn(turns, receivedAt, messageId);
    if (persisted) {
      // Keep the authoritative source ordering while retaining the live row and
      // its semantic segmentation as the render identity.
      turn.createdAt = persisted.createdAt;
      turn.isScheduledRun = persisted.isScheduledRun;
      persistedTurnForLiveTurn.set(turn, persisted);
    }
    liveAssistantTurnsByMessageId.set(messageId, turn);
    messageIdByTurn.set(turn, messageId);
    return turn;
  };

  for (const event of events) {
    while (pendingSyntheticTurns[0] && pendingSyntheticTurns[0].createdAt <= event.receivedAt) {
      const syntheticTurn = pendingSyntheticTurns.shift();
      if (!syntheticTurn) break;
      turns.push(syntheticTurn);
      if (syntheticTurn.role !== "assistant") currentAssistant = null;
    }

    // A gateway suspension can drop tool.complete while leaving tool.start in
    // the buffered live tail. Once history contains that same stable call id,
    // the persisted row is authoritative; replaying the stale start would add
    // a second running generation canvas beside a newer run.
    const hasExplicitToolIdentity =
      event.kind === "tool" && Boolean(event.toolCallId || event.key !== event.name);
    if (event.kind === "tool") {
      if (
        (event.toolCallId && persistedToolResultIds.has(event.toolCallId)) ||
        persistedToolResultIds.has(event.key)
      ) {
        continue;
      }
    }

    switch (event.kind) {
      case "steering": {
        // A user instruction steered into the running turn (feature 06). It is
        // local first-party state, so it gets its own quiet system turn at its
        // `receivedAt` order. Close any open assistant turn so the instruction
        // reads as a beat between what June was doing and what it does next.
        const instruction = event.text.trim();
        if (instruction) {
          turns.push({
            id: `steering:${event.receivedAt}:${turns.length}`,
            role: "system",
            createdAt: event.receivedAt,
            status: "complete",
            parts: [{ type: "steering", text: instruction }],
          });
          currentAssistant = null;
        }
        break;
      }

      case "transcript": {
        const explicitMessageId = event.messageId?.trim() || undefined;
        const isStart = !event.complete && event.delta === undefined;
        if (explicitMessageId) {
          transcriptOwnerMessageId = explicitMessageId;
        } else if (isStart) {
          transcriptOwnerMessageId = undefined;
        }
        const messageId: string | undefined =
          explicitMessageId ??
          (!isStart
            ? ((currentAssistant ? messageIdByTurn.get(currentAssistant) : undefined) ??
              transcriptOwnerMessageId)
            : undefined);
        if (messageId && completedMessageIds.has(messageId)) break;

        if (isStart) {
          currentAssistant = messageId
            ? identifiedAssistantTurn(messageId, event.receivedAt)
            : createAssistantTurn(turns, event.receivedAt);
          currentAssistant.status = "running";
          break;
        }
        currentAssistant = messageId
          ? identifiedAssistantTurn(messageId, event.receivedAt)
          : (currentAssistant ?? createAssistantTurn(turns, event.receivedAt));
        if (!event.complete) {
          currentAssistant.status = "running";
          appendAssistantTextPart(currentAssistant.parts, event.delta ?? "", "running", messageId);
          break;
        }
        const text = event.delta ?? "";
        // A billing failure is recognizable from its "Error:" text prefix; a
        // context overflow is not, so only fold it when the turn actually
        // failed — an ordinary sentence that mentions "context length" stays prose.
        const displayText = stripMediaReferences(text).trim();
        const imageParts = imagePartsFromHermesContent(text);
        const videoParts = videoPartsFromHermesContent(text);
        const notice = displayText
          ? (creditsNoticeFromTurnText(displayText) ??
            (event.failed ? contextOverflowNotice(displayText) : undefined))
          : undefined;
        if (notice) {
          if (
            !currentAssistant.parts.some(
              (part) => part.type === "notice" && part.kind === notice.kind,
            )
          ) {
            currentAssistant.parts.push(notice);
          }
        } else if (text) {
          if (displayText) {
            completeAssistantTextPart(
              currentAssistant.parts,
              displayText,
              messageId,
              imageParts.length > 0 ||
                videoParts.length > 0 ||
                partsContainMediaStructure(currentAssistant.parts),
            );
          }
          appendImageParts(currentAssistant.parts, imageParts);
          appendVideoParts(currentAssistant.parts, videoParts);
        }
        currentAssistant.status = "complete";
        completeRunningParts(currentAssistant.parts);
        if (messageId) completedMessageIds.add(messageId);
        currentAssistant = null;
        break;
      }

      case "reasoning": {
        currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
        currentAssistant.status = "running";
        const messageId = messageIdByTurn.get(currentAssistant);
        if (event.full) {
          // A `*.available` frame carries the FULL reasoning text: replace the
          // thought instead of appending, so a replay after streamed deltas
          // (or a whole-block reasoning model with no deltas at all) renders
          // exactly one copy.
          replaceReasoningPart(currentAssistant.parts, event.delta, messageId);
        } else {
          appendReasoningPart(currentAssistant.parts, event.delta, messageId);
        }
        break;
      }

      case "background_activity": {
        // Delegated subagents (the model's `delegate_task`) stream lifecycle
        // and progress over the same live channel. Render each subagent as a
        // tool-style row keyed by its id, so N parallel subagents show as N live
        // rows that resolve as they finish.
        if (!currentAssistant) {
          currentAssistant = createAssistantTurn(turns, event.receivedAt);
          toolCreatedTurns.add(currentAssistant);
        }
        const { activity } = event;
        const key =
          activity.subagentId === "subagent" && activity.taskIndex !== undefined
            ? `task-${activity.taskIndex}`
            : activity.subagentId;
        const partId = `subagent:${key}`;
        // Keep the richest label we have seen for this subagent: progress and
        // tool events often omit the goal, and downgrading to the generic
        // "Subagent" would make the row flicker. Prefer the goal, else the name
        // already shown, else a task-position label.
        const existingName = currentAssistant.parts.find(
          (part): part is AgentChatToolPart => part.type === "tool" && part.id === partId,
        )?.name;
        const label = activity.goal
          ? `Subagent: ${activity.goal}`
          : (existingName ??
            (activity.taskCount && activity.taskCount > 1 && activity.taskIndex !== undefined
              ? `Subagent ${activity.taskIndex + 1} of ${activity.taskCount}`
              : "Subagent"));
        // `blocked` is resumable, mirroring the activity store's non-terminal phase.
        const status: AgentChatToolPart["status"] =
          activity.phase === "complete"
            ? "complete"
            : activity.phase === "error"
              ? "failed"
              : "running";
        if (status === "running") {
          currentAssistant.status = "running";
        } else if (toolCreatedTurns.has(currentAssistant)) {
          currentAssistant.status = "complete";
        }
        upsertToolPart(currentAssistant.parts, {
          id: partId,
          name: label,
          text: activity.resultPreview ?? "",
          status,
        });
        break;
      }

      case "tool": {
        if (event.isClarify) {
          if (event.phase === "complete" || event.phase === "failed") {
            completePendingClarifyParts(
              (currentAssistant ?? lastAssistantTurn(turns))?.parts ?? [],
            );
          }
          break;
        }
        const status: AgentChatToolPart["status"] =
          event.phase === "complete" ? "complete" : event.phase === "failed" ? "failed" : "running";
        const name = toolActivityLabel(event.name ?? "tool", event.sanitizedPayload);
        const media = generatedMediaToolKind(event.name, event.sanitizedPayload);
        // The pinned gateway's terminal media callback always carries
        // tool_id; only tool.generating is id-less. A terminal frame without
        // identity is ambiguous after reconnect and must not complete another
        // same-name invocation or attach the wrong image/video to it. Hydrated
        // history remains the fallback source of truth for older gateways.
        if (!hasExplicitToolIdentity && media && status !== "running") break;
        if (!hasExplicitToolIdentity && event.phase !== "start") {
          currentAssistant ??= latestAssistantTurnWithRunningTool(turns, name, media);
          // The pinned runtime gives starts a stable tool_id but may omit it
          // from callbacks. An id-less media callback without a live row is an
          // orphan from before a reconnect, not enough identity to create a
          // second placeholder beside persisted history.
          if (!currentAssistant && media) break;
        }
        if (!currentAssistant) {
          currentAssistant = createAssistantTurn(turns, event.receivedAt);
          toolCreatedTurns.add(currentAssistant);
        }
        if (status === "running") {
          currentAssistant.status = "running";
        } else if (toolCreatedTurns.has(currentAssistant)) {
          // A turn that exists only because of tool events has nothing left to
          // stream once its tool reaches a terminal state.
          currentAssistant.status = "complete";
        }
        if (hasExplicitToolIdentity && event.phase === "start" && media) {
          promoteIdlessMediaToolPart(currentAssistant.parts, event.key, name, media);
        }
        upsertToolPart(
          currentAssistant.parts,
          {
            id: hasExplicitToolIdentity
              ? event.key
              : `idless:${event.receivedAt}:${event.key}:${idlessToolSequence++}`,
            name,
            text: event.text,
            status,
            media,
          },
          // Runtime progress callbacks can omit the stable id and carry only
          // the tool name. Fold those into the most recent matching row;
          // explicit ids remain distinct for genuinely concurrent calls.
          !hasExplicitToolIdentity && status === "running" && event.phase !== "start",
        );
        if (status === "complete") {
          appendImageParts(currentAssistant.parts, imagePartsFromHermesContent(event.content));
          appendVideoParts(currentAssistant.parts, videoPartsFromHermesContent(event.content));
        }
        break;
      }

      case "pending_action": {
        currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
        currentAssistant.status = "running";
        const { action } = event;
        switch (action.kind) {
          case "clarify":
            upsertClarifyPart(currentAssistant.parts, {
              id: action.requestId,
              sessionId: optionalSessionId(event.sessionId),
              question: action.question,
              choices: action.choices ?? [],
              status: "pending",
            });
            break;
          case "approval":
            upsertApprovalPart(currentAssistant.parts, {
              id: action.requestId,
              instanceId: action.instanceId,
              command: action.command ?? "",
              description: action.description ?? "Hermes needs approval before continuing.",
              sessionId: optionalSessionId(event.sessionId),
              allowPermanent: action.allowPermanent,
              allowRetiredReopen: action.requestIdProvenance === "payload-fingerprint",
              status: "pending",
            });
            break;
          case "sudo":
            upsertSudoPart(currentAssistant.parts, {
              id: action.requestId,
              sessionId: optionalSessionId(event.sessionId),
              command: action.command,
              reason: action.reason,
              mode: action.mode,
              status: "pending",
            });
            break;
          case "secret":
            upsertSecretPart(currentAssistant.parts, {
              id: action.requestId,
              sessionId: optionalSessionId(event.sessionId),
              keyName: action.keyName,
              reason: action.reason,
              status: "pending",
            });
            break;
        }
        break;
      }

      case "pending_action_resolution": {
        const targetParts = (currentAssistant ?? lastAssistantTurn(turns))?.parts ?? [];
        const { action } = event;
        switch (action.kind) {
          case "clarify":
            upsertClarifyPart(targetParts, {
              id: action.requestId,
              sessionId: optionalSessionId(event.sessionId),
              question: action.question,
              choices: action.choices,
              answer: action.answer,
              status: "resolved",
            });
            break;
          case "approval":
            upsertApprovalPart(targetParts, {
              id: action.requestId,
              instanceId: action.instanceId,
              command: action.command,
              description: action.description,
              sessionId: optionalSessionId(event.sessionId),
              allowPermanent: action.allowPermanent,
              choice: action.choice,
              status: "resolved",
            });
            break;
          case "sudo":
            upsertSudoPart(targetParts, {
              id: action.requestId,
              sessionId: optionalSessionId(event.sessionId),
              mode: action.mode,
              approved: action.granted,
              status: "resolved",
            });
            break;
          case "secret":
            upsertSecretPart(targetParts, {
              id: action.requestId,
              sessionId: optionalSessionId(event.sessionId),
              keyName: action.keyName,
              reason: action.reason,
              status: "resolved",
            });
            break;
        }
        break;
      }

      case "pending_action_expiration": {
        const targetParts = (currentAssistant ?? lastAssistantTurn(turns))?.parts ?? [];
        upsertApprovalPart(targetParts, {
          id: event.action.requestId,
          instanceId: event.action.instanceId,
          command: "",
          description: "",
          sessionId: optionalSessionId(event.sessionId),
          allowPermanent: false,
          status: "expired",
          retiredReason: event.action.reason,
        });
        break;
      }

      case "error": {
        currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
        const notice = event.message ? turnNotice(event.message) : undefined;
        if (notice) {
          currentAssistant.parts.push(notice);
        } else {
          upsertToolPart(currentAssistant.parts, {
            id: `error:${event.receivedAt}`,
            name: "Error",
            text: event.message || "The agent reported an error.",
            status: "failed",
          });
        }
        currentAssistant.status = "complete";
        completeRunningParts(currentAssistant.parts);
        currentAssistant = null;
        break;
      }

      case "lifecycle": {
        if (event.flavor === "terminal") {
          const target = currentAssistant ?? lastAssistantTurn(turns);
          if (target?.status === "running") {
            target.status = "complete";
            completeRunningParts(target.parts);
          }
          currentAssistant = null;
        }
        break;
      }

      case "unsupported":
        break;
    }
  }

  for (const [liveTurn, persistedTurn] of persistedTurnForLiveTurn) {
    const messageId = messageIdByTurn.get(liveTurn);
    if (messageId) reconcilePersistedAssistantTurn(liveTurn, persistedTurn, messageId);
  }

  turns.push(...pendingSyntheticTurns);
}

function createAssistantTurn(turns: AgentChatTurn[], createdAt: string, stableRenderId?: string) {
  // A live assistant turn's `createdAt` is the client's event receive time,
  // while the user/persisted turns it follows carry server timestamps. Those
  // clocks differ, so a raw sort by `createdAt` can float the assistant above
  // the user turn that triggered it — surfacing as a duplicated, misplaced
  // "Thinking…" (the mis-sorted turn shows its own indicator while the gap
  // indicator also fires because the user turn is now last). Clamp to the
  // latest existing turn so an appended turn never sorts before the turns it
  // causally follows; the sort's index tiebreak then keeps a same-timestamp
  // user turn first.
  const latestExisting = turns.reduce(
    (latest, existing) => (existing.createdAt > latest ? existing.createdAt : latest),
    "",
  );
  const orderedCreatedAt = latestExisting > createdAt ? latestExisting : createdAt;
  // The `turns.length` suffix keeps ids unique when several turns are created
  // within the same millisecond, while staying deterministic across rebuilds
  // of the same event list (these ids are used as React keys).
  const turn: AgentChatTurn = {
    id: stableRenderId ?? `assistant:${orderedCreatedAt}:${turns.length}`,
    role: "assistant",
    createdAt: orderedCreatedAt,
    status: "running",
    parts: [],
  };
  turns.push(turn);
  return turn;
}

function lastAssistantTurn(turns: AgentChatTurn[]) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === "assistant") return turns[index];
  }
  return undefined;
}

function optionalSessionId(sessionId: string | undefined) {
  return sessionId || undefined;
}

function appendAssistantTextPart(
  parts: AgentChatPart[],
  delta: string,
  status: "running" | "complete",
  renderIdentity?: string,
) {
  if (!delta) return;
  const last = parts.at(-1);
  if (last?.type === "text") {
    last.text += delta;
    last.status = status;
    return;
  }
  pushAssistantTextPart(parts, delta, status, renderIdentity);
}

function pushAssistantTextPart(
  parts: AgentChatPart[],
  text: string,
  status: "running" | "complete",
  renderIdentity?: string,
  insertAfter?: AgentChatPart,
) {
  const part: AgentChatTextPart = {
    type: "text",
    text,
    status,
    ...(renderIdentity ? { renderKey: semanticPartRenderKey(parts, renderIdentity, "text") } : {}),
  };
  const anchorIndex = insertAfter ? parts.indexOf(insertAfter) : -1;
  if (anchorIndex >= 0) {
    parts.splice(anchorIndex + 1, 0, part);
  } else {
    parts.push(part);
  }
}

// Reconcile the final snapshot against every streamed text segment. A verified
// extension may append to the last segment; every other snapshot is retained
// only as transport evidence and cannot rewrite prose already painted.
function completeAssistantTextPart(
  parts: AgentChatPart[],
  text: string,
  renderIdentity?: string,
  holdTrailingMediaTransport = false,
) {
  const textParts = parts.filter((part): part is AgentChatTextPart => part.type === "text");
  if (textParts.length === 0) {
    if (!text.trim()) return;
    appendAssistantTextPart(parts, text, "complete", renderIdentity);
    return;
  }
  const last = textParts[textParts.length - 1] as AgentChatTextPart;
  const streamed = textParts.map((part) => part.text).join("");
  if (text.startsWith(streamed)) {
    last.text += text.slice(streamed.length);
  } else {
    const visibleStreamed = textParts
      .map((part) =>
        stripRenderedMediaReferences(
          part.text,
          part.status === "running" || holdTrailingMediaTransport,
        ),
      )
      .join("");
    if (text.startsWith(visibleStreamed)) {
      const visibleSuffix = text.slice(visibleStreamed.length);
      if (visibleSuffix) {
        pushAssistantTextPart(parts, visibleSuffix, "complete", renderIdentity, last);
      }
    }
  }
  for (const part of textParts) part.status = "complete";
}

function semanticPartRenderKey(
  parts: AgentChatPart[],
  renderIdentity: string,
  type: "text" | "reasoning",
) {
  const ordinal = parts.filter((part) => part.type === type).length;
  return `${renderIdentity}:${type}:${ordinal}`;
}

function reconcilePersistedAssistantTurn(
  liveTurn: AgentChatTurn,
  persistedTurn: AgentChatTurn,
  messageId: string,
) {
  const persistedText = persistedTurn.parts
    .filter((part): part is AgentChatTextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (persistedText) {
    completeAssistantTextPart(
      liveTurn.parts,
      persistedText,
      messageId,
      partsContainMediaStructure(liveTurn.parts) || partsContainMediaStructure(persistedTurn.parts),
    );
  }

  reconcilePersistedPartOrder(liveTurn.parts, persistedTurn.parts, messageId);

  liveTurn.branchMessageId = messageId;
  liveTurn.status = "complete";
  completeRunningParts(liveTurn.parts);
}

function partsContainMediaStructure(parts: AgentChatPart[]) {
  return parts.some(
    (part) =>
      part.type === "image" ||
      part.type === "video" ||
      (part.type === "tool" && part.media !== undefined),
  );
}

type PersistedReconciliationPart =
  | AgentChatTextPart
  | AgentChatReasoningPart
  | AgentChatToolPart
  | AgentChatImagePart
  | AgentChatVideoPart
  | AgentChatNoticePart;

type PersistedPartAnchor = {
  persisted: PersistedReconciliationPart;
  start?: AgentChatPart;
  end?: AgentChatPart;
  reasoningOrdinal?: number;
};

function reconcilePersistedPartOrder(
  liveParts: AgentChatPart[],
  persistedParts: AgentChatPart[],
  messageId: string,
) {
  const liveTextParts = liveParts.filter((part): part is AgentChatTextPart => part.type === "text");
  const liveReasoningParts = liveParts.filter(
    (part): part is AgentChatReasoningPart => part.type === "reasoning",
  );
  const usedLiveParts = new Set<AgentChatPart>();
  const anchors: PersistedPartAnchor[] = [];
  let claimedLiveReasoning = false;
  let reasoningOrdinal = 0;

  for (const persisted of persistedParts) {
    if (!isPersistedReconciliationPart(persisted)) continue;
    if (persisted.type === "text") {
      anchors.push({
        persisted,
        start: liveTextParts[0],
        end: liveTextParts[liveTextParts.length - 1],
      });
      continue;
    }
    if (persisted.type === "reasoning") {
      const ordinal = reasoningOrdinal;
      reasoningOrdinal += 1;
      if (!claimedLiveReasoning && liveReasoningParts.length > 0) {
        claimedLiveReasoning = true;
        for (const part of liveReasoningParts) usedLiveParts.add(part);
        const liveReasoning = liveReasoningParts.map((part) => part.text).join("\n\n");
        if (persisted.text.startsWith(liveReasoning)) {
          const last = liveReasoningParts[liveReasoningParts.length - 1] as AgentChatReasoningPart;
          last.text += persisted.text.slice(liveReasoning.length);
        }
        for (const part of liveReasoningParts) part.status = "complete";
        anchors.push({
          persisted,
          start: liveReasoningParts[0],
          end: liveReasoningParts[liveReasoningParts.length - 1],
          reasoningOrdinal: ordinal,
        });
      } else {
        anchors.push({ persisted, reasoningOrdinal: ordinal });
      }
      continue;
    }

    const existing = findPersistedStructuredPartMatch(liveParts, persisted, usedLiveParts);
    if (existing) {
      usedLiveParts.add(existing);
      reconcilePersistedStructuredPartInPlace(existing, persisted);
    }
    anchors.push({ persisted, start: existing, end: existing });
  }

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index] as PersistedPartAnchor;
    if (anchor.start) continue;
    const inserted = clonePersistedStructuredPart(
      anchor.persisted,
      messageId,
      anchor.reasoningOrdinal,
    );
    let preceding: AgentChatPart | undefined;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      preceding = anchors[previous]?.end;
      if (preceding) break;
    }
    let following: AgentChatPart | undefined;
    for (let next = index + 1; next < anchors.length; next += 1) {
      following = anchors[next]?.start;
      if (following) break;
    }

    const precedingIndex = preceding ? liveParts.indexOf(preceding) : -1;
    const followingIndex = following ? liveParts.indexOf(following) : -1;
    if (precedingIndex >= 0) {
      liveParts.splice(precedingIndex + 1, 0, inserted);
    } else if (followingIndex >= 0) {
      liveParts.splice(followingIndex, 0, inserted);
    } else {
      liveParts.push(inserted);
    }
    anchor.start = inserted;
    anchor.end = inserted;
  }
}

function isPersistedReconciliationPart(part: AgentChatPart): part is PersistedReconciliationPart {
  return (
    part.type === "text" ||
    part.type === "reasoning" ||
    part.type === "tool" ||
    part.type === "image" ||
    part.type === "video" ||
    part.type === "notice"
  );
}

function findPersistedStructuredPartMatch(
  liveParts: AgentChatPart[],
  persisted: Exclude<PersistedReconciliationPart, AgentChatTextPart | AgentChatReasoningPart>,
  usedLiveParts: ReadonlySet<AgentChatPart>,
) {
  return liveParts.find((live) => {
    if (usedLiveParts.has(live)) return false;
    if (persisted.type === "tool") return live.type === "tool" && live.id === persisted.id;
    if (persisted.type === "image") return live.type === "image" && sameImagePart(live, persisted);
    if (persisted.type === "video") return live.type === "video" && sameVideoPart(live, persisted);
    return live.type === "notice" && live.kind === persisted.kind;
  });
}

function reconcilePersistedStructuredPartInPlace(
  live: AgentChatPart,
  persisted: Exclude<PersistedReconciliationPart, AgentChatTextPart | AgentChatReasoningPart>,
) {
  if (live.type === "tool" && persisted.type === "tool") {
    upsertToolPart([live], persisted);
  } else if (live.type === "image" && persisted.type === "image") {
    Object.assign(live, persisted);
  } else if (live.type === "video" && persisted.type === "video") {
    Object.assign(live, persisted);
  } else if (live.type === "notice" && persisted.type === "notice") {
    Object.assign(live, persisted);
  }
}

function clonePersistedStructuredPart(
  persisted: PersistedReconciliationPart,
  messageId: string,
  reasoningOrdinal?: number,
): AgentChatPart {
  if (persisted.type === "reasoning") {
    return {
      ...persisted,
      renderKey: persisted.renderKey ?? `${messageId}:reasoning:${reasoningOrdinal ?? 0}`,
    };
  }
  return { ...persisted };
}

function appendImageParts(parts: AgentChatPart[], images: AgentChatImagePart[]) {
  for (const image of images) {
    const exists = parts.some((part) => part.type === "image" && sameImagePart(part, image));
    if (!exists) parts.push(image);
  }
}

function appendVideoParts(parts: AgentChatPart[], videos: AgentChatVideoPart[]) {
  for (const video of videos) {
    const exists = parts.some((part) => part.type === "video" && sameVideoPart(part, video));
    if (!exists) parts.push(video);
  }
}

function sameImagePart(left: AgentChatImagePart, right: AgentChatImagePart) {
  if (left.dataUrl && right.dataUrl) return left.dataUrl === right.dataUrl;
  if (left.path && right.path && left.path === right.path) return true;
  const leftName = left.name ?? (left.path ? filenameFromPath(left.path) : undefined);
  const rightName = right.name ?? (right.path ? filenameFromPath(right.path) : undefined);
  const hasBarePath =
    (left.path && left.path === leftName) || (right.path && right.path === rightName);
  return Boolean(
    leftName &&
      rightName &&
      leftName === rightName &&
      // Equal display names bridge an inline MCP image to its trailing MEDIA
      // reference, but never collapse distinct inline payloads or absolute paths.
      ((!left.dataUrl && !right.dataUrl && hasBarePath) ||
        Boolean(left.dataUrl) !== Boolean(right.dataUrl)),
  );
}

function sameVideoPart(left: AgentChatVideoPart, right: AgentChatVideoPart) {
  if (!left.path || !right.path) return false;
  if (left.path === right.path) return true;
  const leftName = filenameFromPath(left.path);
  const rightName = filenameFromPath(right.path);
  return leftName === rightName && (left.path === leftName || right.path === rightName);
}

/** Live tool output and the assistant's trailing MEDIA reference share one
 * turn, but Hermes persists them as consecutive assistant messages. Keep one
 * inline block per generated file until the next user/system turn so reloading
 * history matches the live transcript. */
function deduplicateGeneratedMediaWithinAgentRuns(turns: AgentChatTurn[]) {
  let images: AgentChatImagePart[] = [];
  let videos: AgentChatVideoPart[] = [];

  for (const turn of turns) {
    if (turn.role !== "assistant") {
      images = [];
      videos = [];
      continue;
    }
    turn.parts = turn.parts.filter((part) => {
      if (part.type === "image") {
        if (images.some((image) => sameImagePart(image, part))) return false;
        images.push(part);
      } else if (part.type === "video") {
        if (videos.some((video) => sameVideoPart(video, part))) return false;
        videos.push(part);
      }
      return true;
    });
  }
}

function appendReasoningPart(parts: AgentChatPart[], delta: string, renderIdentity?: string) {
  if (!delta || delta === "thinking.delta" || delta === "reasoning.delta") return;
  const last = parts.at(-1);
  if (last?.type === "reasoning") {
    last.text += delta;
    last.status = "running";
    return;
  }
  parts.push({
    type: "reasoning",
    text: delta,
    status: "running",
    ...(renderIdentity
      ? { renderKey: semanticPartRenderKey(parts, renderIdentity, "reasoning") }
      : {}),
  });
}

/** Replaces the last reasoning part's text with the authoritative full text
 * (a `reasoning.available` frame), creating the part when none streamed. */
function replaceReasoningPart(parts: AgentChatPart[], text: string, renderIdentity?: string) {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.type === "reasoning") {
    last.text = text;
    last.status = "running";
    return;
  }
  parts.push({
    type: "reasoning",
    text,
    status: "running",
    ...(renderIdentity
      ? { renderKey: semanticPartRenderKey(parts, renderIdentity, "reasoning") }
      : {}),
  });
}

function completeRunningParts(parts: AgentChatPart[]) {
  for (const part of parts) {
    if (part.type === "reasoning") part.status = "complete";
    if (part.type === "text") {
      part.status = "complete";
    }
    if (part.type === "tool" && part.status === "running") part.status = "complete";
    if (part.type === "approval" && part.status === "pending") {
      part.status = "expired";
      part.retiredReason = "session-complete";
    }
    if (part.type === "clarify" && part.status === "pending") part.status = "resolved";
    if (part.type === "sudo" && part.status === "pending") part.status = "resolved";
    if (part.type === "secret" && part.status === "pending") part.status = "resolved";
  }
}

function upsertToolPart(
  parts: AgentChatPart[],
  next: Pick<AgentChatToolPart, "id" | "name" | "text" | "status"> &
    Partial<Pick<AgentChatToolPart, "media">>,
  correlateByName = false,
) {
  let existing = parts.find(
    (part): part is AgentChatToolPart =>
      part.type === "tool" &&
      (part.id === next.id || (!next.id && part.name === next.name && part.status === "running")),
  );
  if (!existing && correlateByName) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (
        part?.type === "tool" &&
        part.status === "running" &&
        part.name === next.name &&
        part.media === next.media
      ) {
        existing = part;
        break;
      }
    }
  }
  if (existing) {
    existing.name = next.name && next.name !== "Tool" ? next.name : existing.name;
    existing.status = next.status;
    existing.media ??= next.media;
    if (next.text && next.text !== existing.text) {
      existing.text = appendLogText(existing.text, next.text);
    }
    return;
  }
  parts.push({
    type: "tool",
    id: next.id,
    name: next.name,
    text: next.text,
    status: next.status,
    ...(next.media ? { media: next.media } : {}),
  });
}

function promoteIdlessMediaToolPart(
  parts: AgentChatPart[],
  id: string,
  name: string,
  media: NonNullable<AgentChatToolPart["media"]>,
) {
  // tool.generating precedes tool.start: keep the early canvas mounted while
  // replacing its provisional identity with the execution's stable tool id.
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (
      part?.type === "tool" &&
      part.id.startsWith("idless:") &&
      part.status === "running" &&
      part.name === name &&
      part.media === media
    ) {
      part.id = id;
      return;
    }
  }
}

function latestAssistantTurnWithRunningTool(
  turns: AgentChatTurn[],
  name: string,
  media: AgentChatToolPart["media"] | undefined,
) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      turn?.role === "assistant" &&
      turn.parts.some(
        (part) =>
          part.type === "tool" &&
          part.status === "running" &&
          part.name === name &&
          part.media === media,
      )
    ) {
      return turn;
    }
  }
  return null;
}

function upsertApprovalPart(
  parts: AgentChatPart[],
  next: Pick<
    AgentChatApprovalPart,
    "id" | "command" | "description" | "allowPermanent" | "status"
  > &
    Partial<
      Pick<AgentChatApprovalPart, "choice" | "instanceId" | "sessionId" | "retiredReason">
    > & {
      allowRetiredReopen?: boolean;
    },
) {
  const nextInstanceId = next.instanceId ?? next.id;
  const existing = parts.find(
    (part): part is AgentChatApprovalPart =>
      part.type === "approval" && (part.instanceId ?? part.id) === nextInstanceId,
  );
  if (existing) {
    // Resolution and expiration are sticky for upstream-owned ids. The live
    // stream separately admits a payload-fingerprint id again only after a
    // new Agent-run boundary, so that compatibility identity may reopen here.
    const reopeningRetiredLegacyApproval =
      next.status === "pending" &&
      existing.status !== "pending" &&
      next.allowRetiredReopen === true;
    if (
      next.status === "pending" &&
      existing.status !== "pending" &&
      !reopeningRetiredLegacyApproval
    ) {
      return;
    }
    // A late expiration must not hide the decision the user already made.
    if (next.status === "expired" && existing.status === "resolved") return;
    existing.command = next.command || existing.command;
    existing.description = next.description || existing.description;
    existing.instanceId = next.instanceId ?? existing.instanceId;
    existing.sessionId = next.sessionId || existing.sessionId;
    existing.allowPermanent = next.allowPermanent;
    existing.choice = reopeningRetiredLegacyApproval ? undefined : (next.choice ?? existing.choice);
    existing.retiredReason = reopeningRetiredLegacyApproval
      ? undefined
      : (next.retiredReason ?? existing.retiredReason);
    existing.status = next.status;
    return;
  }
  parts.push({
    type: "approval",
    id: next.id,
    instanceId: next.instanceId,
    sessionId: next.sessionId,
    command: next.command,
    description: next.description,
    allowPermanent: next.allowPermanent,
    choice: next.choice,
    status: next.status,
    retiredReason: next.retiredReason,
  });
}

function upsertClarifyPart(
  parts: AgentChatPart[],
  next: Pick<AgentChatClarifyPart, "id" | "question" | "choices" | "status"> &
    Partial<Pick<AgentChatClarifyPart, "answer" | "sessionId">>,
) {
  const existing = parts.find(
    (part): part is AgentChatClarifyPart => part.type === "clarify" && part.id === next.id,
  );
  if (existing) {
    existing.question = next.question || existing.question;
    existing.choices = next.choices.length ? next.choices : existing.choices;
    existing.answer = next.answer ?? existing.answer;
    existing.sessionId = next.sessionId || existing.sessionId;
    existing.status = next.status;
    return;
  }
  parts.push({
    type: "clarify",
    id: next.id,
    sessionId: next.sessionId,
    question: next.question,
    choices: next.choices,
    answer: next.answer,
    status: next.status,
  });
}

function upsertSudoPart(
  parts: AgentChatPart[],
  next: Pick<AgentChatSudoPart, "id" | "status"> &
    Partial<Pick<AgentChatSudoPart, "command" | "reason" | "mode" | "approved" | "sessionId">>,
) {
  const existing = parts.find(
    (part): part is AgentChatSudoPart => part.type === "sudo" && part.id === next.id,
  );
  if (existing) {
    existing.command = next.command ?? existing.command;
    existing.reason = next.reason ?? existing.reason;
    existing.mode = next.mode ?? existing.mode;
    existing.approved = next.approved ?? existing.approved;
    existing.sessionId = next.sessionId || existing.sessionId;
    existing.status = next.status;
    return;
  }
  parts.push({
    type: "sudo",
    id: next.id,
    sessionId: next.sessionId,
    command: next.command,
    reason: next.reason,
    mode: next.mode,
    approved: next.approved,
    status: next.status,
  });
}

function upsertSecretPart(
  parts: AgentChatPart[],
  next: Pick<AgentChatSecretPart, "id" | "status"> &
    Partial<Pick<AgentChatSecretPart, "keyName" | "reason" | "sessionId">>,
) {
  const existing = parts.find(
    (part): part is AgentChatSecretPart => part.type === "secret" && part.id === next.id,
  );
  if (existing) {
    existing.keyName = next.keyName ?? existing.keyName;
    existing.reason = next.reason ?? existing.reason;
    existing.sessionId = next.sessionId || existing.sessionId;
    existing.status = next.status;
    return;
  }
  parts.push({
    type: "secret",
    id: next.id,
    sessionId: next.sessionId,
    keyName: next.keyName,
    reason: next.reason,
    status: next.status,
  });
}

function messageTimestamp(message: HermesSessionMessage) {
  return timestampString(message.timestamp ?? message.created_at);
}

function parseToolCalls(value: unknown) {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  const calls = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return calls.flatMap((call, index) => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const functionRecord =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : undefined;
    const id =
      stringValue(record.id) ??
      stringValue(record.call_id) ??
      stringValue(record.tool_call_id) ??
      `tool:${index}`;
    const name =
      stringValue(record.name) ??
      stringValue(functionRecord?.name) ??
      stringValue(record.tool_name) ??
      "Tool";
    const args = functionRecord?.arguments ?? record.arguments ?? record.args;
    return [{ id, name, arguments: args }];
  });
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function resolveHermesMessageText(message: HermesSessionMessage) {
  const stripMediaImageReferences = message.role !== "user";
  return (
    textFromHermesContent(message.content, { stripMediaImageReferences }) ??
    textFromHermesContent(message.text, { stripMediaImageReferences }) ??
    textFromHermesContent(message.context, { stripMediaImageReferences }) ??
    stringValue(message.name, true) ??
    ""
  );
}

function displayContentForHermesMessage(message: HermesSessionMessage) {
  const content = resolveHermesMessageText(message);
  if (message.role === "system") return displayedHermesSystemMessageText(content);
  if (message.role !== "user") return content.trim();
  // Hermes appends this as a synthetic user message when an assistant response
  // reaches the provider's output cap. It belongs in the model's continuation
  // context, but never in June's transcript as something the user said.
  if (isHermesOutputLengthContinuationPrompt(content)) return "";
  // Scheduled runs lead with the cron delivery preamble; show the routine's
  // own instructions, not the machine scaffolding.
  return displayedUserPromptText(
    stripImageAnalysisFailureNotice(stripScheduledRunPreamble(stripHermesContextMarkers(content))),
  );
}

// Hermes persists model switches as a system instruction containing internal
// provider metadata. That instruction is useful to the model, but the raw
// routing id and the directive that follows it are implementation details and
// must not leak into the transcript.
function displayedHermesSystemMessageText(content: string) {
  const text = content.trim();
  const match = text.match(
    /^(?:\[System:\s*)?The active model for this chat has changed to\s+(.+?)\s+via provider\s+\S+\./i,
  );
  if (!match?.[1]) return text;
  return `Model changed to ${displayNameForHermesModel(match[1])}.`;
}

function displayNameForHermesModel(modelId: string) {
  const auto = /^__june_auto_generation__:(\d+(?:\.\d+)?)$/i.exec(modelId.trim());
  if (!auto?.[1]) return modelId.trim();

  const qualityPreference = Number(auto[1]);
  if (qualityPreference >= 67) return "Auto Higher";
  if (qualityPreference <= 33) return "Auto Lower";
  return "Auto Balanced";
}

function isHermesOutputLengthContinuationPrompt(content: string) {
  return (
    content.trim() ===
    "[System: Your previous response was truncated by the output length limit. " +
      "Continue exactly where you left off. Do not restart or repeat prior text. " +
      "Finish the answer directly.]"
  );
}

function displayedUserPromptText(content: string) {
  let text = content;
  for (let index = 0; index < 3; index += 1) {
    const next = displayedUserMessageText(displayedSkillInvocationText(text));
    if (next === text) return text;
    text = next;
  }
  return text;
}

export function displayedComposerUserMessageText(content: string): string {
  return stripAttachmentPromptBlock(
    displayedUserPromptText(stripImageAnalysisFailureNotice(content)),
  );
}

function stripImageAnalysisFailureNotice(content: string): string {
  return content.replace(
    /^\s*(?:\[[^\]]*(?:attached an image but analysis failed|vision_analyze)[^\]]*\]\s*)+/i,
    "",
  );
}

function stripAttachmentPromptBlock(content: string): string {
  return content
    .replace(
      /\n+Attached files copied into the June workspace:\n[\s\S]*?\n+Use these file paths when inspecting or operating on the files\.\s*$/i,
      "",
    )
    .trim();
}

function isScheduledRunMessage(message: HermesSessionMessage) {
  return message.role === "user" && isScheduledRunPreamble(resolveHermesMessageText(message));
}

function contextCompactionPartForHermesContent(content: string): AgentChatContextPart | undefined {
  const text = content.trim();
  if (!isHermesContextCompactionSummary(text)) return undefined;
  const detail = stripContextSummaryEndMarker(text);
  return {
    type: "context",
    text: detail,
    preview: contextCompactionPreview(detail),
    status: "complete",
  };
}

function isHermesContextCompactionSummary(value: string) {
  const text = value.trimStart();
  return text.startsWith("[CONTEXT COMPACTION") || text.startsWith("[CONTEXT SUMMARY]:");
}

function stripContextSummaryEndMarker(value: string) {
  return value.replace(/\n*--- END OF CONTEXT SUMMARY[\s\S]*$/m, "").trim();
}

function contextCompactionPreview(value: string) {
  return value.toLowerCase().includes("deterministic fallback")
    ? "Earlier turns were compacted; fallback summary generated without the LLM summarizer."
    : "Earlier turns were compacted into a reference summary.";
}

type TextFromHermesContentOptions = {
  stripMediaImageReferences?: boolean;
};

/**
 * Returns true only when one persisted Agent run ends with a visible assistant
 * reply. Intermediate prose attached to a tool call is not a final reply: all
 * tool results must precede the last content-bearing assistant message, and
 * that final assistant must not request another tool. A following user message
 * starts a different Agent run and is outside this proof boundary.
 */
export function hasFinalContentBearingAssistantReply(
  messages: readonly HermesSessionMessage[],
  persistedUserIndex: number,
) {
  const followingMessages = messages.slice(persistedUserIndex + 1);
  const nextUserIndex = followingMessages.findIndex((message) => message.role === "user");
  const acceptedAgentRunMessages =
    nextUserIndex < 0 ? followingMessages : followingMessages.slice(0, nextUserIndex);
  let lastToolResultIndex = -1;
  acceptedAgentRunMessages.forEach((message, index) => {
    if (message.role === "tool") lastToolResultIndex = index;
  });
  const finalAssistant = acceptedAgentRunMessages
    .slice(lastToolResultIndex + 1)
    .reduce<HermesSessionMessage | undefined>(
      (latest, message) => (message.role === "assistant" ? message : latest),
      undefined,
    );
  return (
    finalAssistant !== undefined &&
    !hermesAssistantMessageHasToolCalls(finalAssistant) &&
    [finalAssistant.content, finalAssistant.text, finalAssistant.context].some(
      (value) => textFromHermesContent(value) !== undefined,
    )
  );
}

function hermesAssistantMessageHasToolCalls(message: HermesSessionMessage) {
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) return toolCalls.length > 0;
  if (typeof toolCalls === "string") {
    const serialized = toolCalls.trim();
    return serialized !== "" && serialized !== "[]";
  }
  return toolCalls !== undefined && toolCalls !== null;
}

export function textFromHermesContent(
  value: unknown,
  options: TextFromHermesContentOptions = {},
): string | undefined {
  return textFromHermesContentInner(value, 0, options);
}

function textFromHermesContentInner(
  value: unknown,
  depth: number,
  options: TextFromHermesContentOptions,
): string | undefined {
  if (value === null || value === undefined || depth > 4) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    const parsed = parseLikelyJsonContent(value);
    if (parsed !== undefined) {
      const parsedText = textFromHermesContentInner(parsed, depth + 1, options);
      if (parsedText?.trim()) return parsedText;
    }
    const text =
      options.stripMediaImageReferences === false ? value : stripMediaImageReferences(value);
    return text.trim() ? text : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value
      .map((item) => textFromHermesContentInner(item, depth + 1, options) ?? "")
      .join("");
    return text.trim() ? text : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // MCP image content blocks carry raw base64 in `data`; never surface that as
    // "text" — it would dump a giant base64 string into a tool row. They render
    // inline as image parts instead (see imagePartsFromHermesContent).
    if (record.type === "image") return undefined;
    for (const key of ["text", "output_text", "content", "message", "delta", "summary"]) {
      const text = textFromHermesContentInner(record[key], depth + 1, options);
      if (text?.trim()) return text;
    }
    return stringifyObject(value) || undefined;
  }
  return undefined;
}

function parseLikelyJsonContent(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  return safeJsonParse(trimmed);
}

function parseUntrustedToolResultEnvelope(value: string) {
  const closingTag = "</untrusted_tool_result>";
  if (!value.trimStart().startsWith("<untrusted_tool_result")) return undefined;
  const closingIndex = value.lastIndexOf(closingTag);
  if (closingIndex < 0) return undefined;
  const body = value.slice(0, closingIndex).trimEnd();
  const payloadStart = body.indexOf("\n\n");
  if (payloadStart < 0) return undefined;
  return safeJsonParse(body.slice(payloadStart + 2).trim());
}

function stripMediaImageReferences(value: string) {
  return stripMediaReferences(value);
}

function stripMediaReferences(value: string) {
  return value
    .replace(mediaImageReferencePattern(), "")
    .replace(mediaVideoReferencePattern(), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Pure display-time scrub for assistant text that still contains media
 * transport references. Complete references are removed in every state. While
 * streaming, also hold back a final line that is a split `MEDIA:` prefix or a
 * still-arriving reference (absolute paths can contain spaces). */
export function stripRenderedMediaReferences(value: string, holdTrailingPartial = false): string {
  const stripped = stripMediaReferences(value);
  if (!holdTrailingPartial) return stripped;
  return stripped.replace(/(^|\r?\n)[ \t]*(?:M|ME|MED|MEDI|MEDIA|MEDIA:.*)$/i, "$1");
}

function mediaImageReferences(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 4) return [];
  if (typeof value === "string") {
    const parsed = parseLikelyJsonContent(value) ?? parseUntrustedToolResultEnvelope(value);
    const nested = parsed !== undefined ? mediaImageReferences(parsed, depth + 1) : [];
    const direct = [...value.matchAll(mediaImageReferencePattern())]
      .map((match) => match[1]?.trim())
      .filter((path): path is string => Boolean(path));
    return uniqueStrings([...nested, ...direct]);
  }
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((item) => mediaImageReferences(item, depth + 1)));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return uniqueStrings(
      [
        "text",
        "output_text",
        "content",
        "result",
        "structuredContent",
        "message",
        "delta",
        "summary",
        "url",
        "image_url",
      ].flatMap((key) => mediaImageReferences(record[key], depth + 1)),
    );
  }
  return [];
}

export function mediaVideoReferences(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 4) return [];
  if (typeof value === "string") {
    const parsed = parseLikelyJsonContent(value) ?? parseUntrustedToolResultEnvelope(value);
    const nested = parsed !== undefined ? mediaVideoReferences(parsed, depth + 1) : [];
    const direct = [...value.matchAll(mediaVideoReferencePattern())]
      .map((match) => match[1]?.trim())
      .filter((path): path is string => Boolean(path));
    return uniqueStrings([...nested, ...direct]);
  }
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((item) => mediaVideoReferences(item, depth + 1)));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return uniqueStrings(
      [
        "text",
        "output_text",
        "content",
        "result",
        "structuredContent",
        "message",
        "delta",
        "summary",
        "url",
        "video_url",
      ].flatMap((key) => mediaVideoReferences(record[key], depth + 1)),
    );
  }
  return [];
}

function mediaImagePart(path: string): AgentChatImagePart {
  return {
    type: "image",
    status: "complete",
    prompt: "Generated image",
    path,
    name: filenameFromPath(path),
  };
}

export function mediaVideoPart(path: string): AgentChatVideoPart {
  return {
    type: "video",
    status: "complete",
    prompt: "Generated video",
    path,
    name: filenameFromPath(path),
  };
}

function filenameFromPath(path: string) {
  const name = path.split(/[\\/]/).pop()?.trim();
  return name || "generated-image.png";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

type McpImageBlock = { data: string; mimeType: string };

/** Collects MCP image content blocks ({type:"image", data:<base64>, mimeType})
 * from a tool result. The content may be an array of blocks, a JSON string of
 * one, or nested under `content`, so walk it defensively (depth-bounded). */
function mcpImageContentBlocks(value: unknown, depth = 0): McpImageBlock[] {
  if (value === null || value === undefined || depth > 4) return [];
  if (typeof value === "string") {
    const parsed = parseLikelyJsonContent(value);
    return parsed !== undefined ? mcpImageContentBlocks(parsed, depth + 1) : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => mcpImageContentBlocks(item, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string" && record.data.trim()) {
      const mimeType =
        typeof record.mimeType === "string" && record.mimeType.trim()
          ? record.mimeType
          : "image/png";
      return [{ data: record.data, mimeType }];
    }
    if (Array.isArray(record.content)) {
      return mcpImageContentBlocks(record.content, depth + 1);
    }
  }
  return [];
}

/** The caption/filename an image tool ({@link mcpImageContentBlocks}) returned
 * alongside its image, carried in a sibling JSON text block ({label, filename}).
 * Best-effort: used for the inline image's alt text and open/download name. */
function mcpImageMetadata(value: unknown, depth = 0): { label?: string; filename?: string } {
  if (value === null || value === undefined || depth > 4) return {};
  if (typeof value === "string") {
    const parsed = parseLikelyJsonContent(value) ?? parseUntrustedToolResultEnvelope(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label : undefined;
      const filename = typeof record.filename === "string" ? record.filename : undefined;
      if (label || filename) return { label, filename };
      for (const key of ["structuredContent", "result", "text", "content"]) {
        const meta = mcpImageMetadata(record[key], depth + 1);
        if (meta.label || meta.filename) return meta;
      }
    }
    return {};
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const meta = mcpImageMetadata(item, depth + 1);
      if (meta.label || meta.filename) return meta;
    }
    return {};
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label : undefined;
    const filename = typeof record.filename === "string" ? record.filename : undefined;
    if (label || filename) return { label, filename };
    for (const key of ["structuredContent", "result", "text", "content"]) {
      const meta = mcpImageMetadata(record[key], depth + 1);
      if (meta.label || meta.filename) return meta;
    }
  }
  return {};
}

/** Turns MCP image content blocks in a tool result into inline image parts, so a
 * tool-produced image (e.g. the `june_image` MCP `generate_image`/`edit_image`
 * tools) renders in-thread the same way the `/image` fast path does — and thus
 * enters the session context the model reads. */
export function imagePartsFromHermesContent(content: unknown): AgentChatImagePart[] {
  const blocks = mcpImageContentBlocks(content);
  const meta = mcpImageMetadata(content);
  const blockParts = blocks.map((block) => ({
    type: "image" as const,
    status: "complete" as const,
    prompt: meta.label?.trim() || "Generated image",
    dataUrl: `data:${block.mimeType};base64,${block.data}`,
    ...(meta.filename ? { name: meta.filename } : {}),
  }));
  const mediaReferences = mediaImageReferences(content);
  const mediaParts = mediaReferences.map((path) => {
    const part = mediaImagePart(path);
    // Hermes persists an MCP image block as a random image_cache path while
    // retaining the tool's signed filename in structuredContent. With one
    // output, that filename is the stable identity used by the assistant's
    // trailing MEDIA ref; keep the cache path for loading and carry the signed
    // name solely for display/deduplication.
    if (mediaReferences.length === 1) {
      if (meta.filename?.trim()) part.name = meta.filename.trim();
      if (meta.label?.trim()) part.prompt = meta.label.trim();
    }
    return part;
  });
  return [...blockParts, ...mediaParts];
}

/** Turns MCP video MEDIA refs into inline video parts, so tool-produced videos
 * render in-thread the same way the `/video` fast path does. */
export function videoPartsFromHermesContent(content: unknown): AgentChatVideoPart[] {
  return mediaVideoReferences(content).map(mediaVideoPart);
}

function stripHermesContextMarkers(value: string) {
  const withoutProjectContext = stripProjectContext(value);
  const withoutWarnings = withoutProjectContext.replace(/\n*--- Context Warnings ---[\s\S]*$/m, "");
  const marker = withoutWarnings.search(/\n*--- Attached Context ---/m);
  const visible = marker >= 0 ? withoutWarnings.slice(0, marker) : withoutWarnings;
  return visible.trim();
}

function stringifyObject(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function completePendingClarifyParts(parts: AgentChatPart[]) {
  const pending = [...parts]
    .reverse()
    .find(
      (part): part is AgentChatClarifyPart => part.type === "clarify" && part.status === "pending",
    );
  if (pending) pending.status = "resolved";
}

function toolStatus(status: AgentToolEventStatus): AgentChatToolPart["status"] {
  if (status === "completed") return "complete";
  if (status === "failed" || status === "blocked") return "failed";
  return "running";
}

function partText(part: AgentChatPart) {
  if (part.type === "tool") return part.text;
  if (part.type === "approval") return part.command || part.description;
  if (part.type === "clarify") return [part.question, part.answer ?? ""].join(" ");
  // A sudo/secret card is meaningful even with no extra text — its presence
  // blocks the turn — so report a non-empty marker so the turn isn't filtered
  // out as empty. The secret value is never part of this (it never reaches a
  // part), so nothing sensitive is reported here.
  if (part.type === "sudo") return [part.command ?? "", part.reason ?? "", "sudo"].join(" ");
  if (part.type === "secret") return [part.keyName ?? "", part.reason ?? "", "secret"].join(" ");
  if (part.type === "context") return part.preview || part.text;
  // A generated image is meaningful even though it has no body text — report the
  // prompt so the turn isn't filtered out as empty and a copy reads sensibly.
  if (part.type === "image") return part.prompt;
  if (part.type === "video") return part.prompt;
  return part.text;
}

function appendLogText(current: string, next: string) {
  if (!next.trim()) return current;
  if (!current) return next;
  if (current.endsWith(next)) return current;
  const separator = /\n$/.test(current) || /^\s/.test(next) || /^[.,!?;:]/.test(next) ? "" : "\n";
  return `${current}${separator}${next}`;
}

function stringValue(value: unknown, preserveWhitespace = false) {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    return preserveWhitespace ? value : value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function timestampString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return new Date().toISOString();
}
