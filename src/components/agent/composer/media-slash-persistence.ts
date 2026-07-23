import type { AgentChatTurn } from "../../../lib/agent-chat-runtime";
import { attachmentStateFrom } from "../../../lib/hermes-image-attach";
import type { ImportedHermesFile } from "../../../lib/tauri";
import type { AgentAttachment } from "../agent-workspace-models";

const IMAGE_SLASH_TURNS_STORAGE_KEY = "june:agent:image-slash-turns";
const VIDEO_SLASH_TURNS_STORAGE_KEY = "june:agent:video-slash-turns";

export type PersistedImageSlashTurn = {
  id: string;
  sessionId: string;
  prompt: string;
  path: string;
  name: string;
  createdAt: string;
  imageCreatedAt: string;
  contextPending: boolean;
  /** True from just before the paid request starts until import succeeds.
   * `path`/`name` are still empty; the fields below carry the replay shape so
   * an app exit mid-generation can retry the SAME June API request instead of
   * minting a new id and a second charge. */
  pending?: boolean;
  requestId?: string;
  model?: string;
  safeMode?: boolean;
};

export type PersistedVideoSlashTurn = {
  id: string;
  sessionId: string;
  prompt: string;
  path: string;
  name: string;
  createdAt: string;
  videoCreatedAt: string;
  pending?: boolean;
  requestId?: string;
  model?: string;
  jobId?: string;
  /** True once the generation completed but its context has not yet ridden a
   * follow-up prompt (the video fold; see storedPendingVideoSlashContexts). */
  contextPending?: boolean;
};

export function imageSlashUserTurn(
  turn: Pick<PersistedImageSlashTurn, "createdAt" | "id" | "prompt">,
) {
  return {
    id: `${turn.id}:user`,
    role: "user" as const,
    createdAt: turn.createdAt,
    status: "complete" as const,
    parts: [{ type: "text" as const, text: turn.prompt, status: "complete" as const }],
  };
}

export function imageSlashAssistantTurn(
  turn: Pick<
    PersistedImageSlashTurn,
    | "id"
    | "imageCreatedAt"
    | "name"
    | "path"
    | "prompt"
    | "createdAt"
    | "pending"
    | "requestId"
    | "model"
    | "safeMode"
  >,
): AgentChatTurn {
  if (turn.pending) {
    // The app exited while this paid generation was in flight. Restore it as
    // a retryable error carrying the pinned request shape - Try again replays
    // the SAME June API request id, so a settled-but-unseen result is
    // deduplicated server-side instead of billed twice.
    return {
      id: `${turn.id}:assistant`,
      role: "assistant",
      createdAt: turn.imageCreatedAt,
      status: "complete",
      parts: [
        {
          type: "image",
          status: "error",
          prompt: turn.prompt,
          requestId: turn.requestId,
          model: turn.model,
          safeMode: turn.safeMode,
          userCreatedAt: turn.createdAt,
          imageCreatedAt: turn.imageCreatedAt,
          error: "Generation was interrupted. Try again to resume.",
        },
      ],
    };
  }
  return {
    id: `${turn.id}:assistant`,
    role: "assistant",
    createdAt: turn.imageCreatedAt,
    status: "complete",
    parts: [
      {
        type: "image",
        status: "complete",
        prompt: turn.prompt,
        path: turn.path,
        name: turn.name,
      },
    ],
  };
}

export function runningImageSlashTurns(input: {
  id: string;
  prompt: string;
  requestId: string;
  createdAt: string;
  imageCreatedAt: string;
  model?: string;
  safeMode?: boolean;
}): AgentChatTurn[] {
  return [
    imageSlashUserTurn(input),
    {
      id: `${input.id}:assistant`,
      role: "assistant",
      createdAt: input.imageCreatedAt,
      status: "running",
      parts: [
        {
          type: "image",
          status: "running",
          prompt: input.prompt,
          requestId: input.requestId,
          model: input.model,
          safeMode: input.safeMode,
          userCreatedAt: input.createdAt,
          imageCreatedAt: input.imageCreatedAt,
        },
      ],
    },
  ];
}

export function videoSlashUserTurn(
  turn: Pick<PersistedVideoSlashTurn, "createdAt" | "id" | "prompt">,
) {
  return {
    id: `${turn.id}:user`,
    role: "user" as const,
    createdAt: turn.createdAt,
    status: "complete" as const,
    parts: [{ type: "text" as const, text: turn.prompt, status: "complete" as const }],
  };
}

export function videoSlashAssistantTurn(
  turn: Pick<
    PersistedVideoSlashTurn,
    | "id"
    | "videoCreatedAt"
    | "name"
    | "path"
    | "prompt"
    | "createdAt"
    | "pending"
    | "requestId"
    | "model"
    | "jobId"
  >,
): AgentChatTurn {
  if (turn.pending) {
    return {
      id: `${turn.id}:assistant`,
      role: "assistant",
      createdAt: turn.videoCreatedAt,
      status: turn.jobId ? "running" : "complete",
      parts: [
        {
          type: "video",
          status: turn.jobId ? "running" : "error",
          prompt: turn.prompt,
          requestId: turn.requestId,
          model: turn.model,
          jobId: turn.jobId,
          userCreatedAt: turn.createdAt,
          videoCreatedAt: turn.videoCreatedAt,
          error: turn.jobId ? undefined : "Generation was interrupted. Try again to resume.",
        },
      ],
    };
  }
  return {
    id: `${turn.id}:assistant`,
    role: "assistant",
    createdAt: turn.videoCreatedAt,
    status: "complete",
    parts: [
      {
        type: "video",
        status: "complete",
        prompt: turn.prompt,
        path: turn.path,
        name: turn.name,
        model: turn.model,
      },
    ],
  };
}

export function runningVideoSlashTurns(input: {
  id: string;
  prompt: string;
  requestId: string;
  createdAt: string;
  videoCreatedAt: string;
  model?: string;
}): AgentChatTurn[] {
  return [
    videoSlashUserTurn(input),
    {
      id: `${input.id}:assistant`,
      role: "assistant",
      createdAt: input.videoCreatedAt,
      status: "running",
      parts: [
        {
          type: "video",
          status: "running",
          prompt: input.prompt,
          requestId: input.requestId,
          model: input.model,
          userCreatedAt: input.createdAt,
          videoCreatedAt: input.videoCreatedAt,
        },
      ],
    },
  ];
}

export function imageSlashTurnsBySessionFromStored(): Record<string, AgentChatTurn[]> {
  const turns = storedImageSlashTurns();
  return Object.fromEntries(
    Object.entries(turns).map(([sessionId, sessionTurns]) => [
      sessionId,
      sessionTurns.flatMap((turn) => [imageSlashUserTurn(turn), imageSlashAssistantTurn(turn)]),
    ]),
  );
}

export function videoSlashTurnsBySessionFromStored(): Record<string, AgentChatTurn[]> {
  const turns = storedVideoSlashTurns();
  return Object.fromEntries(
    Object.entries(turns).map(([sessionId, sessionTurns]) => [
      sessionId,
      sessionTurns.flatMap((turn) => [videoSlashUserTurn(turn), videoSlashAssistantTurn(turn)]),
    ]),
  );
}

export function storedPendingImageSlashAttachments(sessionId: string): AgentAttachment[] {
  return (storedImageSlashTurns()[sessionId] ?? [])
    .filter((turn) => turn.contextPending)
    .map((turn) => {
      const file = importedFileFromImageSlashTurn(turn);
      return {
        ...file,
        id: `held-image:${turn.id}`,
        sourcePrompt: turn.prompt,
        attach: attachmentStateFrom(file, sessionId),
      };
    });
}

export function importedFileFromImageSlashTurn(turn: PersistedImageSlashTurn): ImportedHermesFile {
  return {
    name: turn.name,
    path: turn.path,
    rootLabel: "Workspace",
    size: 0,
    previewDataUrl: null,
  };
}

export function storedImageSlashTurns(): Record<string, PersistedImageSlashTurn[]> {
  try {
    const raw = window.localStorage.getItem(IMAGE_SLASH_TURNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([sessionId, value]) => [
          sessionId,
          Array.isArray(value)
            ? value
                .map((item) => persistedImageSlashTurn(sessionId, item))
                .filter((item): item is PersistedImageSlashTurn => item !== undefined)
            : [],
        ])
        .filter(([, turns]) => turns.length > 0),
    );
  } catch {
    return {};
  }
}

export function persistedImageSlashTurn(
  sessionId: string,
  value: unknown,
): PersistedImageSlashTurn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PersistedImageSlashTurn>;
  // A pending entry (paid request in flight when the app exited) has no
  // path/name yet; its replay request id is what makes it worth restoring.
  const pending =
    candidate.pending === true &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.trim() !== "";
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.prompt !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.imageCreatedAt !== "string" ||
    !candidate.id.trim() ||
    !candidate.prompt.trim() ||
    (!pending && !candidate.path.trim()) ||
    (!pending && !candidate.name.trim()) ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    Number.isNaN(Date.parse(candidate.imageCreatedAt))
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    sessionId,
    prompt: candidate.prompt,
    path: candidate.path,
    name: candidate.name,
    createdAt: candidate.createdAt,
    imageCreatedAt: candidate.imageCreatedAt,
    // A pending turn has no image to attach on the follow-up.
    contextPending: pending ? false : candidate.contextPending !== false,
    ...(pending
      ? {
          pending: true,
          requestId: candidate.requestId,
          model: typeof candidate.model === "string" ? candidate.model : undefined,
          safeMode: typeof candidate.safeMode === "boolean" ? candidate.safeMode : undefined,
        }
      : {}),
  };
}

export function writeStoredImageSlashTurns(turns: Record<string, PersistedImageSlashTurn[]>) {
  try {
    const entries = Object.entries(turns)
      .map(([sessionId, sessionTurns]) => [
        sessionId,
        sessionTurns
          .slice()
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(-50),
      ])
      .filter(([, sessionTurns]) => (sessionTurns as PersistedImageSlashTurn[]).length > 0);
    if (!entries.length) {
      window.localStorage.removeItem(IMAGE_SLASH_TURNS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      IMAGE_SLASH_TURNS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Best-effort restore only; the live in-memory turns still render.
  }
}

export function upsertStoredImageSlashTurn(turn: PersistedImageSlashTurn) {
  const turns = storedImageSlashTurns();
  const sessionTurns = turns[turn.sessionId] ?? [];
  turns[turn.sessionId] = [...sessionTurns.filter((item) => item.id !== turn.id), turn];
  writeStoredImageSlashTurns(turns);
}

export function markStoredImageSlashTurnsAttached(sessionId: string, paths: string[]) {
  if (!paths.length) return;
  const pathSet = new Set(paths);
  const turns = storedImageSlashTurns();
  const sessionTurns = turns[sessionId] ?? [];
  if (!sessionTurns.length) return;
  turns[sessionId] = sessionTurns.map((turn) =>
    pathSet.has(turn.path) ? { ...turn, contextPending: false } : turn,
  );
  writeStoredImageSlashTurns(turns);
}

export function removeStoredImageSlashSession(sessionId: string) {
  const turns = storedImageSlashTurns();
  if (!turns[sessionId]) return;
  delete turns[sessionId];
  writeStoredImageSlashTurns(turns);
}

export function storedVideoSlashTurns(): Record<string, PersistedVideoSlashTurn[]> {
  try {
    const raw = window.localStorage.getItem(VIDEO_SLASH_TURNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([sessionId, value]) => [
          sessionId,
          Array.isArray(value)
            ? value
                .map((item) => persistedVideoSlashTurn(sessionId, item))
                .filter((item): item is PersistedVideoSlashTurn => item !== undefined)
            : [],
        ])
        .filter(([, turns]) => turns.length > 0),
    );
  } catch {
    return {};
  }
}

export function persistedVideoSlashTurn(
  sessionId: string,
  value: unknown,
): PersistedVideoSlashTurn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PersistedVideoSlashTurn>;
  const pending =
    candidate.pending === true &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.trim() !== "";
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.prompt !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.videoCreatedAt !== "string" ||
    !candidate.id.trim() ||
    !candidate.prompt.trim() ||
    (!pending && !candidate.path.trim()) ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    Number.isNaN(Date.parse(candidate.videoCreatedAt))
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    sessionId,
    prompt: candidate.prompt,
    path: candidate.path,
    name: candidate.name,
    createdAt: candidate.createdAt,
    videoCreatedAt: candidate.videoCreatedAt,
    // A pending turn has no completed video to describe on the follow-up.
    // Defaults true for completed turns stored before this field existed, so
    // sessions with an already-generated video get the fold on their next
    // message too.
    contextPending: pending ? false : candidate.contextPending !== false,
    ...(pending
      ? {
          pending: true,
          requestId: candidate.requestId,
          model: typeof candidate.model === "string" ? candidate.model : undefined,
          jobId: typeof candidate.jobId === "string" ? candidate.jobId : undefined,
        }
      : {
          model: typeof candidate.model === "string" ? candidate.model : undefined,
        }),
  };
}

export function writeStoredVideoSlashTurns(turns: Record<string, PersistedVideoSlashTurn[]>) {
  try {
    const entries = Object.entries(turns)
      .map(([sessionId, sessionTurns]) => [
        sessionId,
        sessionTurns
          .slice()
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(-50),
      ])
      .filter(([, sessionTurns]) => (sessionTurns as PersistedVideoSlashTurn[]).length > 0);
    if (!entries.length) {
      window.localStorage.removeItem(VIDEO_SLASH_TURNS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      VIDEO_SLASH_TURNS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Best-effort restore only; the live in-memory turns still render.
  }
}

export function upsertStoredVideoSlashTurn(turn: PersistedVideoSlashTurn) {
  const turns = storedVideoSlashTurns();
  const sessionTurns = turns[turn.sessionId] ?? [];
  turns[turn.sessionId] = [...sessionTurns.filter((item) => item.id !== turn.id), turn];
  writeStoredVideoSlashTurns(turns);
}

export function removeStoredVideoSlashTurn(id: string) {
  const turns = storedVideoSlashTurns();
  let changed = false;
  for (const [sessionId, sessionTurns] of Object.entries(turns)) {
    const nextTurns = sessionTurns.filter((item) => item.id !== id);
    if (nextTurns.length === sessionTurns.length) continue;
    changed = true;
    if (nextTurns.length) {
      turns[sessionId] = nextTurns;
    } else {
      delete turns[sessionId];
    }
  }
  if (changed) writeStoredVideoSlashTurns(turns);
}

export function removeStoredVideoSlashSession(sessionId: string) {
  const turns = storedVideoSlashTurns();
  if (!turns[sessionId]) return;
  delete turns[sessionId];
  writeStoredVideoSlashTurns(turns);
}

/** Completed `/video` fast-path turns whose context has not yet ridden a
 * follow-up prompt. The fast path never invokes the model (skipPrompt), so
 * without this fold a follow-up reads as the first message of the conversation
 * and the model does not know a video was ever generated. Mirrors the JUN-171
 * held-image fold, but as text: no model takes an mp4 as input, so the context
 * is described rather than attached. */
export function storedPendingVideoSlashContexts(sessionId: string): PersistedVideoSlashTurn[] {
  return (storedVideoSlashTurns()[sessionId] ?? []).filter(
    (turn) => turn.contextPending && !turn.pending && turn.path.trim() !== "",
  );
}

export function markStoredVideoSlashContextsSent(sessionId: string, ids: string[]) {
  if (!ids.length) return;
  const idSet = new Set(ids);
  const turns = storedVideoSlashTurns();
  const sessionTurns = turns[sessionId] ?? [];
  if (!sessionTurns.length) return;
  turns[sessionId] = sessionTurns.map((turn) =>
    idSet.has(turn.id) ? { ...turn, contextPending: false } : turn,
  );
  writeStoredVideoSlashTurns(turns);
}

/** Appends the pending `/video` context under the `--- Attached Context ---`
 * marker, which every user-bubble render path already strips - the model sees
 * it, the user never does (same convention as unsupportedImageInputPrompt). */
export function withVideoFastPathContext(
  content: string,
  turns: PersistedVideoSlashTurn[],
): string {
  if (!turns.length) return content;
  return [
    content,
    "",
    "--- Attached Context ---",
    "Earlier in this session the user generated video(s) with the /video command. Those turns ran outside this transcript; the videos already play inline for the user:",
    ...turns.map(
      (turn) =>
        `- prompt: "${turn.prompt}" -> ${turn.name || "video"}${
          turn.model ? ` (model: ${turn.model})` : ""
        }, saved at ${turn.path}`,
    ),
    "Generated videos cannot be edited in place. If the user asks to change, extend, or redo a video, call the june_video generate_video tool with a revised full prompt (or animate_image to animate a source image).",
  ].join("\n");
}

export function filenameFromWorkspacePath(path: string, fallback: string) {
  const name = path.split(/[\\/]/).pop()?.trim();
  return name || fallback;
}

export function uniqueAttachmentsByWorkspacePath(attachments: AgentAttachment[]) {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = attachment.attach.workspacePath ?? attachment.path ?? attachment.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function promptSubmitContentWithFastPathImageContext(
  content: string,
  heldImages: AgentAttachment[],
) {
  const prompts = [
    ...new Set(
      heldImages
        .map((attachment) => attachment.sourcePrompt?.trim())
        .filter((prompt): prompt is string => Boolean(prompt)),
    ),
  ];
  if (!prompts.length) return content;
  // Tuck the prompt(s) under the "--- Attached Context ---" marker (same
  // convention as unsupportedImageInputPrompt) so the model reads it but
  // displayContentForHermesMessage strips it on reload — otherwise the
  // "Previous /image request: ..." line shows as user-authored text.
  const contextLines =
    prompts.length === 1
      ? [`Previous /image request: ${prompts[0]}`]
      : ["Previous /image requests:", ...prompts.map((prompt, index) => `${index + 1}. ${prompt}`)];
  return [content, "", "--- Attached Context ---", ...contextLines].join("\n");
}

/** Thrown when a structured image attach fails so the prompt is NOT sent with a
 * missing image (feature 19). Carries the attachments with their failed status
 * so submit()'s catch can restore the chips showing what didn't go through. */
export class AttachBlockedError extends Error {
  constructor(
    message: string,
    readonly attachments: AgentAttachment[],
  ) {
    super(message);
    this.name = "AttachBlockedError";
  }
}
