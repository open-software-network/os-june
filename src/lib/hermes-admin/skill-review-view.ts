/**
 * Pure, render-free view logic for the agent-managed skill write review queue
 * (admin surfaces spec 12): the shape of a staged write as June shows it, the
 * provenance / operation / gate labeling, the safety framing, and the
 * gate-toggle copy. Kept separate from the React component and the data hook so
 * "the diff is readable", "provenance is clear", and "the gate copy is honest"
 * are unit-testable without rendering and without a Tauri runtime.
 *
 * Nothing here talks to Hermes; it only reshapes already-parsed pending writes
 * the Rust `hermes_pending_skill_writes` command returns. Copy is sentence case,
 * no em/en-dashes, per June conventions.
 *
 * Version gating: the Rust reader is the source of truth for whether a manifest
 * was recognized (`readable`). This module never re-decides that; it only
 * renders the consequence (an unreadable write can be rejected but not
 * approved) so the gate can never be bypassed by a stale UI.
 */

/** What a staged write does to the target file. Mirrors the Rust enum. */
export type PendingSkillWriteOp = "create" | "edit" | "delete" | "unknown";

/** Where the agent proposed the write came from. Mirrors the Rust enum. */
export type PendingSkillWriteSource = "foreground" | "background" | "unknown";

/** One affected file inside a staged write. */
export type PendingSkillWriteFile = {
  /** Path relative to the managed skills root. */
  relativePath: string;
  /** Unified diff of the proposed change, when supplied. */
  diff?: string;
  /** The proposed full content (create/edit), already redacted by Rust. */
  content?: string;
  /** True when `content`/`diff` was redacted because it held secret-shaped text. */
  redacted?: boolean;
};

/** One staged, agent-authored skill write awaiting review. */
export type PendingSkillWrite = {
  /** Stable, arg-safe id used to approve/reject. */
  id: string;
  skill: string;
  op: PendingSkillWriteOp;
  source: PendingSkillWriteSource;
  /** One-line human gist of the change, when supplied. */
  gist?: string;
  /** Epoch ms the write was staged, when supplied. */
  stagedAt?: number;
  files: PendingSkillWriteFile[];
  /** True when Rust recognized the manifest. A false here means the write can be
   * rejected but NOT approved (approve fails closed in Rust). */
  readable: boolean;
};

/** Parses the raw value the Tauri command returns into a typed
 * {@link PendingSkillWrite}. Defensive: tolerates missing fields and never
 * throws, so a malformed entry still renders rather than crashing the page. */
export function parsePendingSkillWrite(raw: unknown): PendingSkillWrite | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pickString(record, ["id"]);
  if (!id) return null;
  return {
    id,
    skill: pickString(record, ["skill", "skillName", "name"]) ?? id,
    op: normalizeOp(record.op),
    source: normalizeSource(record.source),
    gist: pickString(record, ["gist", "summary"]),
    stagedAt: pickNumber(record, ["stagedAt", "staged_at"]),
    files: parseFiles(record.files),
    readable: record.readable === true,
  };
}

/** Parses the command's array result into a clean list, dropping unparseable
 * entries. */
export function parsePendingSkillWrites(raw: unknown): PendingSkillWrite[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingSkillWrite[] = [];
  for (const entry of raw) {
    const parsed = parsePendingSkillWrite(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Display metadata for an operation: a short label and the safety framing of
 * what approving it does to procedural memory. */
export type OpMeta = {
  op: PendingSkillWriteOp;
  /** Short pill label, sentence case. */
  label: string;
  /** What approving this change does. */
  effect: string;
};

const OP_META: Readonly<Record<PendingSkillWriteOp, OpMeta>> = Object.freeze({
  create: {
    op: "create",
    label: "New skill",
    effect: "Adds a new skill to procedural memory.",
  },
  edit: {
    op: "edit",
    label: "Edit",
    effect: "Changes an existing skill in procedural memory.",
  },
  delete: {
    op: "delete",
    label: "Delete",
    effect: "Removes a skill from procedural memory.",
  },
  unknown: {
    op: "unknown",
    label: "Change",
    effect: "June could not read what this change does.",
  },
});

/** The display metadata for an operation. */
export function opMeta(op: PendingSkillWriteOp): OpMeta {
  return OP_META[op];
}

/** Provenance metadata: a label and a one-line explanation of where the write
 * came from, so the user can weigh a background self-improvement edit
 * differently from one they prompted in a foreground task. */
export type WriteSourceMeta = {
  source: PendingSkillWriteSource;
  label: string;
  blurb: string;
};

const SOURCE_META: Readonly<Record<PendingSkillWriteSource, WriteSourceMeta>> =
  Object.freeze({
    foreground: {
      source: "foreground",
      label: "From a task",
      blurb: "Proposed while the agent was working on something you asked for.",
    },
    background: {
      source: "background",
      label: "Self-improvement",
      blurb: "Proposed by the agent's background self-improvement review.",
    },
    unknown: {
      source: "unknown",
      label: "Source unknown",
      blurb: "Hermes did not report where this change came from.",
    },
  });

/** The display metadata for a write's source. */
export function writeSourceMeta(
  source: PendingSkillWriteSource,
): WriteSourceMeta {
  return SOURCE_META[source];
}

/** A one-line gist for a write: the manifest's own gist when present, otherwise
 * a derived "<op> <skill>" so every row has a readable headline. */
export function writeGist(write: PendingSkillWrite): string {
  if (write.gist) return write.gist;
  const meta = opMeta(write.op);
  switch (write.op) {
    case "create":
      return `Add skill ${write.skill}`;
    case "delete":
      return `Remove skill ${write.skill}`;
    case "edit":
      return `Update skill ${write.skill}`;
    default:
      return `${meta.label} to ${write.skill}`;
  }
}

/** The distinct affected file paths for a write, for the "affected files" line. */
export function affectedFiles(write: PendingSkillWrite): string[] {
  return write.files.map((file) => file.relativePath);
}

/** True when any file in the write was redacted before reaching June, so the UI
 * can warn that the displayed diff hides secret-shaped lines. */
export function hasRedactedContent(write: PendingSkillWrite): boolean {
  return write.files.some((file) => file.redacted === true);
}

/** Whether June can apply this write. False when:
 * - the manifest is unreadable / has no recognized op, or
 * - any file was redacted: June only holds the masked copy of that content, so
 *   applying it would persist `[redacted]` and corrupt the skill. Both fail
 *   closed in Rust too; the UI disables Approve to match so it never offers an
 *   action that will error. A redacted write must be approved in Hermes. */
export function canApprove(write: PendingSkillWrite): boolean {
  return write.readable && write.op !== "unknown" && !hasRedactedContent(write);
}

// ---------------------------------------------------------------------------
// Gate (skills.write_approval) copy + reading.
// ---------------------------------------------------------------------------

/** The dotted config path the write-approval gate lives at. */
export const WRITE_APPROVAL_PATH = "skills.write_approval";

/** The spec's gate explanation, shown next to the toggle. */
export const WRITE_APPROVAL_ON_COPY =
  "When approval is on, June can suggest skill improvements, but procedural memory changes do not land until you approve the diff.";

/** The consequence of turning the gate OFF, so the user understands they are
 * removing the human-in-the-loop check. */
export const WRITE_APPROVAL_OFF_COPY =
  "With approval off, the agent can change its own skills without asking. New sessions pick up the change.";

/** Reads the boolean `skills.write_approval` value out of a parsed config tree.
 * Tolerant of string "true"/"false" and 1/0. Defaults to false (the gate is
 * off) when the key is absent, matching Hermes's default. */
export function readWriteApproval(config: Record<string, unknown>): boolean {
  const skills = asRecord(config.skills);
  const value = skills?.write_approval ?? skills?.writeApproval;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return (
      lower === "true" || lower === "1" || lower === "yes" || lower === "on"
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Local, dependency-free readers.
// ---------------------------------------------------------------------------

function normalizeOp(value: unknown): PendingSkillWriteOp {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "create":
      return "create";
    case "edit":
      return "edit";
    case "delete":
      return "delete";
    default:
      return "unknown";
  }
}

function normalizeSource(value: unknown): PendingSkillWriteSource {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "foreground":
      return "foreground";
    case "background":
      return "background";
    default:
      return "unknown";
  }
}

function parseFiles(value: unknown): PendingSkillWriteFile[] {
  if (!Array.isArray(value)) return [];
  const out: PendingSkillWriteFile[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const relativePath = pickString(record, [
      "relativePath",
      "relative_path",
      "path",
    ]);
    if (!relativePath) continue;
    out.push({
      relativePath,
      diff: pickString(record, ["diff", "patch"]),
      content: pickString(record, ["content"]),
      redacted: record.redacted === true,
    });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
