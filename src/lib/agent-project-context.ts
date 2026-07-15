export type AgentProjectContext = {
  id: string;
  name: string;
  instructions?: string;
};

export type PreparedProjectPrompt = {
  text: string;
  injected: boolean;
  contextSignature: string | null;
};

const CONTEXT_OPEN_MARKER = "[June project context]";
const CONTEXT_CLOSE_MARKER = "[/June project context]";

/** Recorded after a session is compacted while filed in a project. It never
 * equals a real project signature (those are JSON arrays), so a still-filed
 * session reinjects on its next prompt; and it is not `undefined`/`null`, so
 * if the session is unfiled before that prompt the clearing block still
 * fires. */
export const COMPACTED_CONTEXT_SIGNATURE = "compacted";

// The block is injected into user-role prompt text (Hermes has no separate
// structured-context channel on prompt.submit), so the markers are forgeable
// by construction. Two mitigations keep display honest: marker lines are
// stripped out of the injected payload so instructions can never terminate
// the envelope early, and stripping only removes a leading block that
// byte-exactly matches the generated shape.
function sanitizeContextPayload(value: string): string {
  return value
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== CONTEXT_OPEN_MARKER && trimmed !== CONTEXT_CLOSE_MARKER;
    })
    .join("\n");
}

function projectContextSignature(project: AgentProjectContext): string {
  return JSON.stringify([project.id, project.name, project.instructions ?? ""]);
}

function renderProjectContext(project: AgentProjectContext): string {
  const instructions = sanitizeContextPayload(project.instructions?.trim() ?? "") || "(none)";
  const name = sanitizeContextPayload(project.name).replace(/\n/g, " ");
  return [
    CONTEXT_OPEN_MARKER,
    `project_id: ${project.id}`,
    `project: ${name}`,
    "instructions:",
    instructions,
    CONTEXT_CLOSE_MARKER,
  ].join("\n");
}

/** Signature recorded after delivering the "left the project" marker, so the
 * clearing block goes out exactly once and a later re-filing (any real
 * project signature differs) reinjects normally. */
export const CLEARED_CONTEXT_SIGNATURE = "cleared";

function renderClearedContext(): string {
  return [
    CONTEXT_OPEN_MARKER,
    "project_id: (none)",
    "project: (none)",
    "instructions:",
    "This session is no longer filed in a project. Previous project instructions no longer apply; use only global memory.",
    CONTEXT_CLOSE_MARKER,
  ].join("\n");
}

export function prepareProjectPrompt(
  prompt: string,
  project: AgentProjectContext | undefined,
  previousContextSignature: string | null | undefined,
): PreparedProjectPrompt {
  if (!project) {
    // A project block was delivered earlier in this conversation: tell the
    // model the filing ended, or it keeps following stale instructions.
    if (previousContextSignature && previousContextSignature !== CLEARED_CONTEXT_SIGNATURE) {
      return {
        text: `${renderClearedContext()}\n\n${prompt}`,
        injected: true,
        contextSignature: CLEARED_CONTEXT_SIGNATURE,
      };
    }
    return { text: prompt, injected: false, contextSignature: previousContextSignature ?? null };
  }

  const contextSignature = projectContextSignature(project);
  if (contextSignature === previousContextSignature) {
    return { text: prompt, injected: false, contextSignature };
  }

  return {
    text: `${renderProjectContext(project)}\n\n${prompt}`,
    injected: true,
    contextSignature,
  };
}

const SIGNATURES_STORAGE_KEY = "june.project-context.signatures";
const SIGNATURES_MAX_ENTRIES = 500;

/** Last delivered context signature per stored session id, persisted so a
 * June restart still knows a past conversation carries a project block —
 * without this, moving an old session out of its project after a reload
 * would skip the clearing marker and stale instructions would keep applying.
 * Losing the store is safe in the other direction: an empty map merely
 * reinjects. Insertion-ordered; pruned to the newest entries. */
export class ProjectContextSignatureStore {
  private entries: Map<string, string | null>;

  constructor(private storageKey = SIGNATURES_STORAGE_KEY) {
    this.entries = new Map();
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            Array.isArray(item) &&
            typeof item[0] === "string" &&
            (typeof item[1] === "string" || item[1] === null)
          ) {
            this.entries.set(item[0], item[1]);
          }
        }
      }
    } catch {
      // Corrupt or unavailable storage starts fresh — worst case is a
      // harmless reinjection.
    }
  }

  get(sessionId: string): string | null | undefined {
    return this.entries.get(sessionId);
  }

  set(sessionId: string, signature: string | null): void {
    // Re-inserting moves the entry to the newest position so pruning drops
    // genuinely stale sessions first.
    this.entries.delete(sessionId);
    this.entries.set(sessionId, signature);
    while (this.entries.size > SIGNATURES_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.persist();
  }

  delete(sessionId: string): void {
    if (this.entries.delete(sessionId)) this.persist();
  }

  private persist(): void {
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify([...this.entries]));
    } catch {
      // A failed persist degrades to the pre-persistence in-memory behavior.
    }
  }
}

// Matches only a block with the exact generated shape: the five fixed lines
// with a single-line project_id and project name, a non-greedy instructions
// body, and the closing marker followed by the blank separator. A user
// message that merely starts with the open marker does not match and stays
// visible. A hand-typed byte-exact well-formed block is hidden from display;
// the model saw it either way.
const GENERATED_CONTEXT_BLOCK =
  /^\[June project context\]\nproject_id: [^\n]*\nproject: [^\n]*\ninstructions:\n[\s\S]*?\n\[\/June project context\]\n\n/;

export function stripProjectContext(prompt: string): string {
  const match = GENERATED_CONTEXT_BLOCK.exec(prompt);
  return match ? prompt.slice(match[0].length) : prompt;
}

/** Session previews are TRUNCATED snippets of the raw prompt text, so a
 * project-filed session's preview can open with the injected block cut off
 * before its close marker — the strict full-block strip above can't match
 * it. For previews: drop a complete leading block like the strict strip;
 * when the block is truncated (no close marker), nothing of the user's own
 * text is present, so blank the preview rather than expose instructions. */
export function stripProjectContextFromPreview(preview: string | undefined): string | undefined {
  if (!preview || !preview.startsWith(CONTEXT_OPEN_MARKER)) return preview;
  const closeIndex = preview.indexOf(CONTEXT_CLOSE_MARKER);
  if (closeIndex < 0) return undefined;
  return preview.slice(closeIndex + CONTEXT_CLOSE_MARKER.length).trim() || undefined;
}
