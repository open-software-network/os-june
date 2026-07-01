/**
 * Pure, render-free view logic for the skill detail viewer + safe editor
 * (spec 05). It owns everything that can be decided WITHOUT React or a network:
 *
 * - separating a SKILL.md document into its frontmatter block and its body, so
 *   the viewer can show "what the agent is told" distinctly from metadata;
 * - validating an edited SKILL.md before it is ever sent (frontmatter still
 *   parses, required name/description present, size within the limit, no
 *   secret-looking value pasted into the body);
 * - computing the edit policy for a skill from its source/read-only state, so
 *   read-only and writable are ENFORCED in logic, not merely styled, and the
 *   per-source editing risks (bundled update drift, hub upstream divergence,
 *   external-dir sharing) are labeled honestly;
 * - grouping a skill's supporting files (`references/`/`templates/`/`scripts/`/
 *   `assets/`) from whatever Hermes reports;
 * - a minimal line diff for the diff-before-save confirmation.
 *
 * Nothing here talks to Hermes; it only reshapes already-parsed data. Copy is
 * sentence case, no em/en-dashes. NO value is ever logged here: the secret scan
 * reports only that a line LOOKS secret and where, never the matched text.
 */

import type { HermesSkillInfo, HermesSkillSource } from "./schemas";

/** The hard cap on a SKILL.md June will save, mirroring the Rust bridge's
 * `HERMES_SKILL_MAX_BYTES` (512 KiB). Validation rejects an edit past this so a
 * paste of a huge blob never reaches the wire (and never silently truncates).
 * Measured in UTF-8 bytes, not characters, to match the server's byte check. */
export const SKILL_MD_MAX_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** A SKILL.md split into its YAML frontmatter block and its markdown body. When
 * a document has no frontmatter, `frontmatter` is undefined and `body` is the
 * whole text. The raw frontmatter text is preserved (not re-serialized) so the
 * editor round-trips a user's exact formatting. */
export type SkillDocumentParts = {
  /** The raw text BETWEEN the `---` fences, without the fences. Undefined when
   * the document has no frontmatter block. */
  frontmatter?: string;
  /** The markdown body after the closing fence (or the whole doc when there is
   * no frontmatter). */
  body: string;
  /** True when a frontmatter block was present (even if empty). Lets the
   * validator require valid frontmatter only when the skill uses it. */
  hasFrontmatter: boolean;
};

/** Splits a SKILL.md into frontmatter + body. A frontmatter block is the
 * leading `---` ... `---` fence at the very start of the file (optionally after
 * a UTF-8 BOM / leading blank lines), mirroring how Hermes reads skill
 * metadata. Tolerant of `\r\n`. Never throws. */
export function splitSkillDocument(content: string): SkillDocumentParts {
  // Tolerate a BOM and the most common newline styles; do NOT trim the body,
  // so the editor preserves trailing content exactly.
  const withoutBom = content.replace(/^﻿/, "");
  const match =
    /^(?:\s*\n)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(
      withoutBom,
    );
  if (!match) {
    return { body: content, hasFrontmatter: false };
  }
  return {
    frontmatter: match[1] ?? "",
    body: match[2] ?? "",
    hasFrontmatter: true,
  };
}

/** A single `key: value` read from frontmatter, for the small set of fields the
 * detail view shows and the validator checks. This is intentionally a minimal,
 * forgiving line reader, NOT a full YAML parser: it reads top-level scalar keys
 * and ignores nested/sequence structures, which is all the metadata fields
 * (name, description, version, ...) need. */
export type FrontmatterScalars = Readonly<Record<string, string>>;

/** Reads top-level `key: value` scalar pairs from a frontmatter block. Quoted
 * values are unwrapped; lines that begin a nested block (`key:` with no value)
 * or a sequence are skipped. Returns an empty map for empty/whitespace input.
 * Never throws — a malformed line is skipped, not fatal. */
export function readFrontmatterScalars(
  frontmatter: string,
): FrontmatterScalars {
  const out: Record<string, string> = {};
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // Skip blanks, comments, and sequence items.
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.trimStart().startsWith("- ")) continue;
    // Only top-level keys (no leading indent) are read as scalars.
    if (/^\s/.test(rawLine)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key) continue;
    // Strip an inline `# comment` only when the value is unquoted.
    if (value && value[0] !== '"' && value[0] !== "'") {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    value = unquote(value);
    out[key.toLowerCase()] = value;
  }
  return Object.freeze(out);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Edit policy / provenance
// ---------------------------------------------------------------------------

/** Whether and how June may write a skill, with the honest user-facing reason.
 * `editable` is the ENFORCED gate (the editor refuses to save when false), not a
 * styling hint. `warning`, when present, is shown before the user starts
 * editing a writable-but-risky skill (bundled / hub) so the consequence is
 * known up front. */
export type SkillEditPolicy = {
  /** True only when June can safely write this skill's source. */
  editable: boolean;
  /** Why it is read-only, when it is. Sentence case, no dashes. */
  readOnlyReason?: string;
  /** A pre-edit risk note for a writable skill whose edits have consequences
   * (bundled update drift, hub upstream divergence). Undefined for a plain
   * local/custom skill with no special risk. */
  warning?: string;
  /** True when editing requires an explicit extra confirmation that the user
   * accepts the source may be shared with other tools (external dirs that June
   * has been granted write access to). Defaults false. */
  requiresSharedSourceAck: boolean;
};

/** The per-source editing risk copy, kept in one place so the warnings match
 * the spec's wording and June's no-dashes / sentence-case rules. */
type SourceRisk = { editable: boolean; warning?: string; readOnly?: string };
const SOURCE_RISK: Readonly<Record<string, SourceRisk>> = Object.freeze({
  local: { editable: true },
  unknown: { editable: true },
  hub: {
    editable: true,
    warning:
      "This skill was installed from the Skills Hub. Editing it locally may diverge from the upstream version and can affect future updates.",
  },
  bundled: {
    editable: true,
    warning:
      "This skill ships with Hermes. Local edits stop automatic bundled updates until you reset it.",
  },
  external: {
    editable: false,
    readOnly:
      "This skill loads from an external directory. It may be shared with other tools, so June treats it as read-only.",
  },
});

// `local` is not in HermesSkillSource today (the inventory reports bundled / hub
// / external / unknown), but the policy table includes it so a future "local"
// source is handled, and so an `unknown` source from a writable path is treated
// as editable rather than guessing read-only.

/** Decides the edit policy for a skill. The `readOnly` flag from the inventory
 * (or the document fetch) is authoritative: when Hermes/the bridge says a skill
 * cannot be written, June never offers to save it, regardless of source. When
 * the skill is writable, the source decides the risk warning. */
export function skillEditPolicy(input: {
  source: HermesSkillSource;
  readOnly: boolean;
}): SkillEditPolicy {
  const risk = SOURCE_RISK[input.source] ?? SOURCE_RISK.unknown;
  // A hard read-only flag wins over the source's nominal editability.
  if (input.readOnly || !risk.editable) {
    return {
      editable: false,
      readOnlyReason:
        risk.readOnly ??
        "This skill is read-only in June and cannot be edited here.",
      requiresSharedSourceAck: false,
    };
  }
  return {
    editable: true,
    warning: risk.warning,
    requiresSharedSourceAck: false,
  };
}

// ---------------------------------------------------------------------------
// Supporting files
// ---------------------------------------------------------------------------

/** The four standard supporting-file groups a Hermes skill can bundle, plus an
 * "other" bucket. Each is a list of relative paths Hermes reported; an empty
 * list means "none reported" (which may mean none exist OR that upstream did not
 * list them — the UI says "if available" rather than asserting zero). */
export type SkillSupportingFiles = {
  references: string[];
  templates: string[];
  scripts: string[];
  assets: string[];
  other: string[];
};

const GROUP_PREFIXES: ReadonlyArray<[keyof SkillSupportingFiles, string]> = [
  ["references", "references/"],
  ["templates", "templates/"],
  ["scripts", "scripts/"],
  ["assets", "assets/"],
];

/** Groups a skill's supporting files by their top-level directory, reading
 * whatever list Hermes reports on the skill's raw payload (`files`, `bundle`,
 * `contents`, ...). `SKILL.md` itself is excluded (it is shown separately). A
 * path outside the four known groups lands in `other`. Returns empty groups
 * when nothing is reported. */
export function skillSupportingFiles(
  skill: HermesSkillInfo,
): SkillSupportingFiles {
  const groups: SkillSupportingFiles = {
    references: [],
    templates: [],
    scripts: [],
    assets: [],
    other: [],
  };
  for (const path of supportingFilePaths(skill)) {
    const normalized = path.replace(/^\.?\//, "");
    if (/^skill\.md$/i.test(normalized)) continue;
    const group = GROUP_PREFIXES.find(([, prefix]) =>
      normalized.toLowerCase().startsWith(prefix),
    );
    if (group) groups[group[0]].push(normalized);
    else groups.other.push(normalized);
  }
  for (const key of Object.keys(groups) as (keyof SkillSupportingFiles)[]) {
    groups[key] = [...new Set(groups[key])].sort((a, b) => a.localeCompare(b));
  }
  return groups;
}

/** True when a skill reports no supporting files at all. Lets the UI show an
 * honest "no supporting files reported" line instead of four empty groups. */
export function hasSupportingFiles(files: SkillSupportingFiles): boolean {
  return (
    files.references.length > 0 ||
    files.templates.length > 0 ||
    files.scripts.length > 0 ||
    files.assets.length > 0 ||
    files.other.length > 0
  );
}

/** Reads a flat list of relative file paths from a skill's raw payload,
 * tolerating a few shapes Hermes might use. Defensive: anything not a string is
 * dropped. */
function supportingFilePaths(skill: HermesSkillInfo): string[] {
  const record = asRecord(skill.raw);
  if (!record) return [];
  const candidate =
    record.files ??
    record.supporting_files ??
    record.supportingFiles ??
    record.contents ??
    record.bundle_files ??
    record.bundleFiles;
  return toStringList(candidate) ?? [];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A single validation problem with an edited SKILL.md. `severity` lets the UI
 * BLOCK on an error but only WARN on a secret-looking value (the user may have a
 * legitimate reason, but is told secrets belong in `.env`). */
export type SkillContentIssue = {
  severity: "error" | "warning";
  /** A short, user-facing message. Never contains a matched secret value. */
  message: string;
  /** 1-based line number the issue points at, when applicable. */
  line?: number;
};

/** The result of validating an edited SKILL.md. `canSave` is false when ANY
 * error is present; warnings never block (they are acknowledged in the UI). */
export type SkillContentValidation = {
  canSave: boolean;
  issues: SkillContentIssue[];
};

/** Whether a field is required for THIS skill. Name is always required; a
 * description is required only when the skill already declared one (we do not
 * force a description onto a skill that never had it). */
export type SkillContentRequirements = {
  requireName: boolean;
  requireDescription: boolean;
};

/**
 * Validates an edited SKILL.md before save:
 *
 * - if the document has frontmatter, it must still be a parseable block with a
 *   closing fence (we do not let a half-deleted `---` ship);
 * - `name` (and `description` when required) must be present in frontmatter;
 * - the UTF-8 byte size must be within {@link SKILL_MD_MAX_BYTES};
 * - any line whose VALUE looks like a secret raises a WARNING (not an error):
 *   secrets belong in `.env` / secret config, not in SKILL.md.
 *
 * Pure and synchronous. Reports issues; never mutates input; never logs.
 */
export function validateSkillContent(
  content: string,
  requirements: SkillContentRequirements,
): SkillContentValidation {
  const issues: SkillContentIssue[] = [];

  // Size first: a giant paste is rejected outright (matches the server's cap).
  const bytes = utf8ByteLength(content);
  if (bytes > SKILL_MD_MAX_BYTES) {
    issues.push({
      severity: "error",
      message: `This skill is too large to save (${formatKib(bytes)}, limit ${formatKib(SKILL_MD_MAX_BYTES)}).`,
    });
  }

  const parts = splitSkillDocument(content);

  // A lone opening `---` with no closing fence is the most common way to break
  // frontmatter while editing; splitSkillDocument returns hasFrontmatter:false
  // for it, so detect the dangling fence explicitly.
  if (!parts.hasFrontmatter && hasDanglingFrontmatterFence(content)) {
    issues.push({
      severity: "error",
      message:
        "Frontmatter looks unterminated. Close the metadata block with a line containing only ---.",
      line: 1,
    });
  }

  if (parts.hasFrontmatter) {
    const scalars = readFrontmatterScalars(parts.frontmatter ?? "");
    if (requirements.requireName && !scalars.name) {
      issues.push({
        severity: "error",
        message: "Frontmatter is missing a name.",
      });
    }
    if (requirements.requireDescription && !scalars.description) {
      issues.push({
        severity: "error",
        message: "Frontmatter is missing a description.",
      });
    }
  } else if (requirements.requireName) {
    issues.push({
      severity: "error",
      message: "This skill needs frontmatter with at least a name.",
    });
  }

  for (const finding of scanForSecrets(content)) {
    issues.push({
      severity: "warning",
      message:
        "A value here looks like a secret. Secrets belong in .env or secret config, not in SKILL.md.",
      line: finding.line,
    });
  }

  return {
    canSave: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

/** Detects an opening `---` fence with no matching closing fence anywhere after
 * it, i.e. a frontmatter block the user has half-broken while editing. */
function hasDanglingFrontmatterFence(content: string): boolean {
  const withoutBom = content.replace(/^﻿/, "");
  if (!/^(?:\s*\n)?---[ \t]*\r?\n/.test(withoutBom)) return false;
  // There is an opening fence but the full frontmatter regex did not match, so
  // there is no valid closing fence.
  return true;
}

/** A secret-looking line, identified by 1-based line number ONLY. The matched
 * value is deliberately never returned, so a finding can be logged or shown
 * without leaking the secret. */
export type SecretFinding = { line: number };

/** Scans content for lines that assign a secret-looking value, e.g.
 * `api_key: sk-...`, `OPENAI_API_KEY=...`, `token: "ghp_..."`. Reports the line
 * number only. Heuristic, intentionally conservative: it flags a value that is
 * EITHER under a clearly-secret key OR a credential-shaped token, so a benign
 * sentence does not trip it. Used to WARN, never to block. */
export function scanForSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lineLooksSecret(lines[i])) findings.push({ line: i + 1 });
  }
  return findings;
}

const SECRET_KEY =
  /(api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key|client[_-]?secret|bearer)\b/i;
// A credential-shaped token: a long, separator-free run (mirrors the redaction
// heuristic in redact.ts). A filesystem path / URL is exempt.
const CREDENTIAL_TOKEN = /[A-Za-z0-9_+/=.-]{24,}/;
const KNOWN_SECRET_PREFIX =
  /\b(sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|hf_|pk_live_|sk_live_)\S*/;

/** True when a single line assigns a secret-looking value. */
function lineLooksSecret(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  // Split on the first `=` or `:` so we look at the VALUE, not the key alone.
  const sepMatch = /[:=]/.exec(trimmed);
  const key = sepMatch ? trimmed.slice(0, sepMatch.index) : "";
  const value = sepMatch ? trimmed.slice(sepMatch.index + 1).trim() : trimmed;
  const unq = value.replace(/^["']|["']$/g, "");
  if (!unq) return false;
  // A path or URL is a location, not a credential.
  const looksLikePath =
    unq.includes("/") || unq.includes("\\") || /^[a-z]+:\/\//i.test(unq);
  if (KNOWN_SECRET_PREFIX.test(unq)) return true;
  if (SECRET_KEY.test(key) && !looksLikePath && CREDENTIAL_TOKEN.test(unq)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Diff (for the diff-before-save confirmation)
// ---------------------------------------------------------------------------

/** One line in a unified-style diff. `unchanged` lines give context; `added`
 * and `removed` carry the actual change. */
export type SkillDiffLine = {
  kind: "added" | "removed" | "unchanged";
  text: string;
};

/** A compact summary of a SKILL.md edit for the confirmation dialog. */
export type SkillDiff = {
  lines: SkillDiffLine[];
  addedCount: number;
  removedCount: number;
  /** True when the two documents are identical (no change to save). */
  unchanged: boolean;
};

/**
 * Computes a line-level diff between the original and edited SKILL.md for the
 * diff-before-save confirmation. Uses a longest-common-subsequence pass so the
 * result reads as real insertions/deletions rather than a wholesale replace.
 * Pure; suitable for the small documents SKILL.md edits produce.
 */
export function diffSkillContent(before: string, after: string): SkillDiff {
  if (before === after) {
    return { lines: [], addedCount: 0, removedCount: 0, unchanged: true };
  }
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = lcsTable(a, b);
  const lines: SkillDiffLine[] = [];
  let i = a.length;
  let j = b.length;
  const stack: SkillDiffLine[] = [];
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      stack.push({ kind: "unchanged", text: a[i - 1] });
      i--;
      j--;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      stack.push({ kind: "removed", text: a[i - 1] });
      i--;
    } else {
      stack.push({ kind: "added", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) stack.push({ kind: "removed", text: a[--i] });
  while (j > 0) stack.push({ kind: "added", text: b[--j] });
  for (let k = stack.length - 1; k >= 0; k--) lines.push(stack[k]);

  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { lines, addedCount: added, removedCount: removed, unchanged: false };
}

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i][j] =
        a[i - 1] === b[j - 1]
          ? table[i - 1][j - 1] + 1
          : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// Local, dependency-free helpers (mirrors installed-skills-view's style).
// ---------------------------------------------------------------------------

function utf8ByteLength(value: string): number {
  // TextEncoder is available in the renderer and in jsdom; fall back to a
  // surrogate-aware estimate if it is ever missing.
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function formatKib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
      else {
        const record = asRecord(entry);
        const path =
          record &&
          (typeof record.path === "string"
            ? record.path
            : typeof record.name === "string"
              ? record.name
              : undefined);
        if (path && path.trim()) out.push(path.trim());
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}
