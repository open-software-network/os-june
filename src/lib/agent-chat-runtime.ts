import type { AgentItemDto } from "./agent-runtime-contract";
import { stripProjectContext } from "./agent-project-context";

export type AgentChatTextPart = { type: "text"; text: string; status?: "running" | "complete" };
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
  media?: "image" | "video";
};
export type AgentApprovalChoice = "once" | "session" | "always" | "deny";
export type AgentChatApprovalPart = {
  type: "approval";
  id: string;
  runId: string;
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
  runId: string;
  sessionId?: string;
  question: string;
  choices: string[];
  answer?: string;
  status: "pending" | "resolved";
};
export type AgentChatSudoPart = {
  type: "sudo";
  id: string;
  command?: string;
  reason?: string;
  mode?: "sandboxed" | "unrestricted";
  approved?: boolean;
  status: "pending" | "resolved";
};

export const UPSTREAM_PROVIDER_FAILURE_NOTICE_BODY =
  "The upstream provider could not complete this request.";
export type AgentChatSecretPart = {
  type: "secret";
  id: string;
  runId: string;
  keyName?: string;
  reason?: string;
  status: "pending" | "resolved";
};
export type AgentChatNoticePart = {
  type: "notice";
  kind: "credits" | "context-overflow" | "upstream-provider" | "tool" | "runtime";
  text: string;
  retryable?: boolean;
};
export type AgentChatSteeringPart = { type: "steering"; text: string };
export type AgentChatAttachmentPart = {
  type: "attachment";
  name: string;
  path: string;
  kind: "image" | "file";
};
export type AgentChatImagePart = {
  type: "image";
  status: "running" | "complete" | "error";
  prompt: string;
  requestId?: string;
  model?: string;
  safeMode?: boolean;
  userCreatedAt?: string;
  imageCreatedAt?: string;
  path?: string;
  dataUrl?: string;
  name?: string;
  error?: string;
};
export type AgentChatVideoPart = {
  type: "video";
  status: "running" | "complete" | "error";
  prompt: string;
  requestId?: string;
  model?: string;
  userCreatedAt?: string;
  videoCreatedAt?: string;
  jobId?: string;
  path?: string;
  posterDataUrl?: string;
  name?: string;
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
  | AgentChatAttachmentPart
  | AgentChatImagePart
  | AgentChatVideoPart;

export type AgentChatTurn = {
  id: string;
  branchMessageId?: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  status: "running" | "complete";
  parts: AgentChatPart[];
  isScheduledRun?: boolean;
};

export type CompanionAgentMessageView = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  streaming: false;
  media?: CompanionMediaReference[];
};

export type CompanionMediaReference = {
  artifactId: string;
  kind: "image" | "video";
  mediaType: string;
  widthPx?: number;
  heightPx?: number;
  durationMs?: number;
  sizeBytes: number;
};

export type CompanionMediaProjection = {
  runId?: string;
  createdAt: string;
  reference: CompanionMediaReference;
};

const COMPANION_MESSAGE_TEXT_BYTES = 30 * 1024;

export function boundedCompanionText(text: string, maxBytes: number, suffix = "...") {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  const suffixBytes = encoder.encode(suffix).byteLength;
  const pieces: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes + suffixBytes > maxBytes) break;
    pieces.push(character);
    bytes += characterBytes;
  }
  return `${pieces.join("").trimEnd()}${suffix}`;
}

/**
 * Projects persisted agent runtime items onto the companion's deliberately
 * small transcript contract. Selecting completed message items only keeps
 * reasoning, tools, approvals, secrets, and media internals on the Mac.
 */
export function companionAgentMessagesFromItems(
  items: AgentItemDto[],
  mediaProjections: CompanionMediaProjection[] = [],
): CompanionAgentMessageView[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const messages = items.flatMap((item) => {
    if (item.kind !== "message" || item.status !== "complete") return [];
    const text = (item.role === "user" ? stripProjectContext(item.text) : item.text).trim();
    if (!text) return [];
    const suffix = "\n\n[Message truncated on companion]";
    const message: CompanionAgentMessageView = {
      id: item.id,
      role: item.role,
      text: boundedCompanionText(text, COMPANION_MESSAGE_TEXT_BYTES, suffix),
      createdAt: item.createdAt,
      streaming: false,
    };
    // JSON escaping can expand control-heavy text beyond its UTF-8 size. Keep
    // one item below the frame budget even in that pathological case.
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 34 * 1024) {
      message.text = boundedCompanionText(text, 5 * 1024, suffix);
    }
    return [message];
  });
  const lastAssistantByRun = new Map<string, CompanionAgentMessageView>();
  for (const message of messages) {
    const item = itemsById.get(message.id);
    if (item?.kind === "message" && item.role === "assistant" && item.runId) {
      lastAssistantByRun.set(item.runId, message);
    }
  }
  const overflow: CompanionMediaProjection[] = [];
  for (const projection of mediaProjections) {
    const target = projection.runId ? lastAssistantByRun.get(projection.runId) : undefined;
    if (target && (target.media?.length ?? 0) < 8) {
      target.media = [...(target.media ?? []), projection.reference];
    } else {
      overflow.push(projection);
    }
  }
  const mediaOnlyMessages = overflow.map(
    (projection): CompanionAgentMessageView => ({
      id: `media:${projection.reference.artifactId}`,
      role: "assistant",
      text: "",
      createdAt: projection.createdAt,
      streaming: false,
      media: [projection.reference],
    }),
  );
  return [...messages, ...mediaOnlyMessages].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

const CONTRACTION_GLUE = /([A-Za-z])('(?:s|re|ve|ll|m|d|t))(?=[A-Za-z])/gi;

export function repairContractionSpacing(text: string): string {
  return text.replace(CONTRACTION_GLUE, (whole, pre: string, enclitic: string) =>
    pre.toLowerCase() === "s" ? whole : `${pre}${enclitic} `,
  );
}

const MEDIA_REFERENCE =
  /MEDIA:(?:\/[^\r\n]+?|[A-Za-z0-9._-]+?)\.(?:png|jpe?g|gif|webp|tiff?|bmp|avif|mp4|mov|webm|m4v)(?:[)\].,;:]?)(?=\s|$)/gi;

export function stripRenderedMediaReferences(value: string, holdTrailingPartial = false): string {
  const stripped = value
    .replace(MEDIA_REFERENCE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return holdTrailingPartial
    ? stripped.replace(/(^|\r?\n)[ \t]*(?:M|ME|MED|MEDI|MEDIA|MEDIA:.*)$/i, "$1")
    : stripped;
}

export function displayedComposerUserMessageText(content: string): string {
  return content
    .replace(/\n*\[Image attached at:\s*[^\]]+\]\s*(?:\[[^\]\n]+\]\s*)*$/i, "")
    .replace(/^\s*\[(?:Clovy|June) attachment manifest v1\][\s\S]*?\n\n/, "")
    .trim();
}
