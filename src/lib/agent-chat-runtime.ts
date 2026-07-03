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
import { toolActivityLabel } from "./agent-tool-labels";

export type AgentChatTextPart = {
  type: "text";
  text: string;
  status?: "running" | "complete";
};

export type AgentChatReasoningPart = {
  type: "reasoning";
  text: string;
  status: "running" | "complete";
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
};

export type AgentApprovalChoice = "once" | "session" | "always" | "deny";

export type AgentChatApprovalPart = {
  type: "approval";
  id: string;
  sessionId?: string;
  command: string;
  description: string;
  allowPermanent: boolean;
  choice?: AgentApprovalChoice;
  status: "pending" | "resolved";
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
  | AgentChatImagePart;

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
const MEDIA_IMAGE_REFERENCE_PATTERN = new RegExp(
  `MEDIA:(/[^\\r\\n]+?\\.(?:${MEDIA_IMAGE_EXTENSION_PATTERN}))(?:[)\\].,;:]?)(?=\\s|$)`,
  "gi",
);
const mediaImageReferencePattern = () =>
  new RegExp(MEDIA_IMAGE_REFERENCE_PATTERN.source, MEDIA_IMAGE_REFERENCE_PATTERN.flags);

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
): AgentChatTurn[] {
  const turns: AgentChatTurn[] = [];
  const toolResults = new Map<string, HermesSessionMessage>();

  for (const message of messages) {
    if (message.role === "tool") {
      const id = message.tool_call_id ?? message.id;
      toolResults.set(id, message);
      const turn =
        lastAssistantTurn(turns) ?? createAssistantTurn(turns, messageTimestamp(message));
      upsertToolPart(turn.parts, {
        id,
        name: toolActivityLabel(message.tool_name ?? undefined),
        text: textFromHermesContent(message.content) ?? "",
        status: "complete",
      });
      // An image tool result carries its image inline (base64); render it as an
      // image part so it shows in-thread instead of being lost to the collapsed
      // tool row. The base64 is stripped from the tool text above.
      for (const imagePart of imagePartsFromHermesContent(message.content)) {
        turn.parts.push(imagePart);
      }
      turn.status = "complete";
      continue;
    }

    const content = displayContentForHermesMessage(message);
    const messageImageParts =
      message.role === "assistant" ? imagePartsFromHermesContent(message.content) : [];
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
        turn.parts.push({
          type: "tool",
          id: call.id,
          name: toolActivityLabel(call.name, call.arguments),
          text: textFromHermesContent(result?.content) ?? stringifyObject(call.arguments) ?? "",
          status: "complete",
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
      }
    }

    if (turn.parts.length) {
      turns.push(turn);
    }
  }

  appendLiveHermesEvents(turns, liveEvents);
  return sortAgentChatTurns(
    turns.filter((turn) =>
      turn.parts.some((part) => part.type === "tool" || partText(part).trim()),
    ),
  );
}

// Contraction/possessive enclitics the gateway tokenizes as their own chunk
// (`'s`, `'re`, `'t`, …). When it reassembles a streamed message for storage
// it strips the leading space off the chunk that follows one, so the next
// word glues on: "it's not" persists as "it'snot", "Mac's camera" as
// "Mac'scamera". The damage is in the persisted text and survives reloads, so
// the live-stream reconciliation (whitespaceLossyCopyOf) can't undo it — this
// repairs it at display time.
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
  const text = turn?.parts
    .filter((part): part is AgentChatTextPart => part.type === "text")
    .map((part) => part.text)
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

function appendLiveHermesEvents(turns: AgentChatTurn[], events: JuneHermesEvent[]) {
  let currentAssistant: AgentChatTurn | null = null;
  const toolCreatedTurns = new Set<AgentChatTurn>();

  for (const event of events) {
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
        if (!event.complete && event.delta === undefined) {
          currentAssistant = createAssistantTurn(turns, event.receivedAt);
          currentAssistant.status = "running";
          break;
        }
        currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
        if (!event.complete) {
          currentAssistant.status = "running";
          appendAssistantTextPart(currentAssistant.parts, event.delta ?? "", "running");
          break;
        }
        const text = event.delta ?? "";
        // A billing failure is recognizable from its "Error:" text prefix; a
        // context overflow is not, so only fold it when the turn actually
        // failed — an ordinary sentence that mentions "context length" stays prose.
        const displayText = stripMediaImageReferences(text);
        const imageParts = imagePartsFromHermesContent(text);
        const notice = displayText
          ? (creditsNoticeFromTurnText(displayText) ??
            (event.failed ? contextOverflowNotice(displayText) : undefined))
          : undefined;
        if (notice) {
          // The complete text is authoritative for the turn (see
          // completeAssistantTextPart); when it's a billing failure, any
          // partially streamed text is superseded along with it.
          currentAssistant.parts = currentAssistant.parts.filter((part) => part.type !== "text");
          currentAssistant.parts.push(notice);
        } else if (text) {
          if (displayText.trim()) {
            completeAssistantTextPart(currentAssistant.parts, displayText);
          } else if (imageParts.length) {
            removeAssistantTextParts(currentAssistant.parts);
          }
          appendImageParts(currentAssistant.parts, imageParts);
        }
        currentAssistant.status = "complete";
        completeRunningParts(currentAssistant.parts);
        currentAssistant = null;
        break;
      }

      case "reasoning": {
        currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
        currentAssistant.status = "running";
        if (event.full) {
          // A `*.available` frame carries the FULL reasoning text: replace the
          // thought instead of appending, so a replay after streamed deltas
          // (or a whole-block reasoning model with no deltas at all) renders
          // exactly one copy.
          replaceReasoningPart(currentAssistant.parts, event.delta);
        } else {
          appendReasoningPart(currentAssistant.parts, event.delta);
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
        if (!currentAssistant) {
          currentAssistant = createAssistantTurn(turns, event.receivedAt);
          toolCreatedTurns.add(currentAssistant);
        }
        const status: AgentChatToolPart["status"] =
          event.phase === "complete" ? "complete" : event.phase === "failed" ? "failed" : "running";
        if (status === "running") {
          currentAssistant.status = "running";
        } else if (toolCreatedTurns.has(currentAssistant)) {
          // A turn that exists only because of tool events has nothing left to
          // stream once its tool reaches a terminal state.
          currentAssistant.status = "complete";
        }
        upsertToolPart(currentAssistant.parts, {
          id: event.key,
          name: toolActivityLabel(event.name ?? "tool", event.sanitizedPayload),
          text: event.text,
          status,
        });
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
              command: action.command ?? "",
              description: action.description ?? "Hermes needs approval before continuing.",
              sessionId: optionalSessionId(event.sessionId),
              allowPermanent: action.allowPermanent,
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
}

function createAssistantTurn(turns: AgentChatTurn[], createdAt: string) {
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
    id: `assistant:${orderedCreatedAt}:${turns.length}`,
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
) {
  if (!delta) return;
  const last = parts.at(-1);
  if (last?.type === "text") {
    last.text += delta;
    last.status = status;
    return;
  }
  parts.push({ type: "text", text: delta, status });
}

// `message.complete` carries the authoritative full text for the turn, so we
// reconcile it against the concatenation of every streamed text part rather
// than only the last one (a turn can interleave text -> tool -> text).
function completeAssistantTextPart(parts: AgentChatPart[], text: string) {
  if (!text.trim()) return;
  const textParts = parts.filter((part): part is AgentChatTextPart => part.type === "text");
  if (textParts.length === 0) {
    parts.push({ type: "text", text, status: "complete" });
    return;
  }
  const last = textParts[textParts.length - 1] as AgentChatTextPart;
  const earlier = textParts.slice(0, -1);
  const earlierText = earlier.map((part) => part.text).join("");
  const streamed = earlierText + last.text;
  // The gateway builds the authoritative complete text by concatenating its
  // internal chunks, which can trim each chunk (dropping a boundary space the
  // live stream delivered correctly — "explore it." -> "exploreit.") or lag
  // behind the stream. The streamed deltas are appended verbatim, so when
  // `text` equals the stream with whitespace *removed* — the signature of
  // joining trimmed chunks — or is just a shorter prefix of it, keep the
  // verbatim stream instead of overwriting it with the lossy/truncated
  // payload. Whitespace that was *changed* (a streamed newline arriving as a
  // space, say) is a genuine correction and falls through to reconciliation.
  if (whitespaceLossyCopyOf(streamed, text) || streamed.startsWith(text)) {
    for (const part of textParts) part.status = "complete";
    return;
  }
  if (!earlier.length) {
    last.text = text;
  } else if (text.startsWith(earlierText)) {
    last.text = text.slice(earlierText.length);
  } else {
    // The streamed parts cannot be reconciled with the complete text; replace
    // the text parts wholesale, keeping tool parts in position.
    for (const part of earlier) {
      const index = parts.indexOf(part);
      if (index >= 0) parts.splice(index, 1);
    }
    last.text = text;
  }
  last.status = "complete";
  for (const part of earlier) {
    part.status = "complete";
  }
}

function removeAssistantTextParts(parts: AgentChatPart[]) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") parts.splice(index, 1);
  }
}

function appendImageParts(parts: AgentChatPart[], images: AgentChatImagePart[]) {
  for (const image of images) {
    const exists = parts.some(
      (part) =>
        part.type === "image" &&
        ((image.path && part.path === image.path) ||
          (image.dataUrl && part.dataUrl === image.dataUrl)),
    );
    if (!exists) parts.push(image);
  }
}

// True when `complete` can be derived from `streamed` purely by deleting
// whitespace characters. Deliberately rejects whitespace substitutions:
// deletions are the only damage joining trimmed chunks can do, so anything
// else is a real edit the caller should honor.
function whitespaceLossyCopyOf(streamed: string, complete: string) {
  let from = 0;
  for (let to = 0; to < complete.length; to += 1) {
    while (from < streamed.length && streamed[from] !== complete[to]) {
      if (!/\s/.test(streamed[from] as string)) return false;
      from += 1;
    }
    if (from >= streamed.length) return false;
    from += 1;
  }
  return !streamed.slice(from).trim();
}

function appendReasoningPart(parts: AgentChatPart[], delta: string) {
  if (!delta || delta === "thinking.delta" || delta === "reasoning.delta") return;
  const last = parts.at(-1);
  if (last?.type === "reasoning") {
    last.text += delta;
    last.status = "running";
    return;
  }
  parts.push({ type: "reasoning", text: delta, status: "running" });
}

/** Replaces the last reasoning part's text with the authoritative full text
 * (a `reasoning.available` frame), creating the part when none streamed. */
function replaceReasoningPart(parts: AgentChatPart[], text: string) {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.type === "reasoning") {
    last.text = text;
    last.status = "running";
    return;
  }
  parts.push({ type: "reasoning", text, status: "running" });
}

function completeRunningParts(parts: AgentChatPart[]) {
  for (const part of parts) {
    if (part.type === "reasoning") part.status = "complete";
    if (part.type === "text") part.status = "complete";
    if (part.type === "tool" && part.status === "running") part.status = "complete";
    if (part.type === "approval" && part.status === "pending") part.status = "resolved";
    if (part.type === "clarify" && part.status === "pending") part.status = "resolved";
    if (part.type === "sudo" && part.status === "pending") part.status = "resolved";
    if (part.type === "secret" && part.status === "pending") part.status = "resolved";
  }
}

function upsertToolPart(
  parts: AgentChatPart[],
  next: Pick<AgentChatToolPart, "id" | "name" | "text" | "status">,
) {
  const existing = parts.find(
    (part): part is AgentChatToolPart =>
      part.type === "tool" &&
      (part.id === next.id || (!next.id && part.name === next.name && part.status === "running")),
  );
  if (existing) {
    existing.name = next.name && next.name !== "Tool" ? next.name : existing.name;
    existing.status = next.status;
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
  });
}

function upsertApprovalPart(
  parts: AgentChatPart[],
  next: Pick<
    AgentChatApprovalPart,
    "id" | "command" | "description" | "allowPermanent" | "status"
  > &
    Partial<Pick<AgentChatApprovalPart, "choice" | "sessionId">>,
) {
  const existing = parts.find(
    (part): part is AgentChatApprovalPart => part.type === "approval" && part.id === next.id,
  );
  if (existing) {
    existing.command = next.command || existing.command;
    existing.description = next.description || existing.description;
    existing.sessionId = next.sessionId || existing.sessionId;
    existing.allowPermanent = next.allowPermanent;
    existing.choice = next.choice ?? existing.choice;
    existing.status = next.status;
    return;
  }
  parts.push({
    type: "approval",
    id: next.id,
    sessionId: next.sessionId,
    command: next.command,
    description: next.description,
    allowPermanent: next.allowPermanent,
    choice: next.choice,
    status: next.status,
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
  if (message.role !== "user") return content.trim();
  // Scheduled runs lead with the cron delivery preamble; show the routine's
  // own instructions, not the machine scaffolding.
  return displayedUserPromptText(
    stripImageAnalysisFailureNotice(stripScheduledRunPreamble(stripHermesContextMarkers(content))),
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

function stripMediaImageReferences(value: string) {
  return value
    .replace(mediaImageReferencePattern(), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function mediaImageReferences(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 4) return [];
  if (typeof value === "string") {
    const parsed = parseLikelyJsonContent(value);
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
      ["text", "output_text", "content", "message", "delta", "summary", "url", "image_url"].flatMap(
        (key) => mediaImageReferences(record[key], depth + 1),
      ),
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
    const parsed = parseLikelyJsonContent(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label : undefined;
      const filename = typeof record.filename === "string" ? record.filename : undefined;
      if (label || filename) return { label, filename };
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
    if (typeof record.text === "string") {
      const meta = mcpImageMetadata(record.text, depth + 1);
      if (meta.label || meta.filename) return meta;
    }
    if (Array.isArray(record.content)) {
      return mcpImageMetadata(record.content, depth + 1);
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
  const mediaParts = mediaImageReferences(content).map(mediaImagePart);
  return [...blockParts, ...mediaParts];
}

function stripHermesContextMarkers(value: string) {
  const withoutWarnings = value.replace(/\n*--- Context Warnings ---[\s\S]*$/m, "");
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
