/**
 * Pure helpers + copy for the Team skill taps manager (admin surfaces spec 13).
 * A tap is a GitHub repository of reusable SKILL.md directories. June validates
 * the `owner/repo` and optional path BEFORE they ever reach the Rust bridge (which
 * validates them again as defense in depth), maps a tap to a trust badge, and
 * builds the upstream identifier the existing Skills Hub search/install flow uses
 * to surface a tap's skills. None of this touches Tauri or the network, so it is
 * unit-tested in isolation.
 */

import type { HermesSkillTapDto } from "../tauri";

/** The default path Hermes reads a tap's skills from when no override is set. */
export const DEFAULT_TAP_PATH = "skills/";

/** The org-friendly explainer the spec asks June to surface verbatim. Kept here
 * so the copy lives next to the validators it describes. */
export const TAP_EXPLAINER =
  "A tap is a GitHub repository of reusable SKILL.md directories. Use taps for team runbooks, deployment procedures, and shared workflows.";

/** A tap's trust badge. June marks a tap trusted ONLY when Hermes says so;
 * everything else is community (review before installing). */
export type TapTrustMeta = {
  level: "trusted" | "community";
  /** Short pill label, sentence case. */
  label: string;
  /** Tone the UI styles the badge with. */
  tone: "trusted" | "caution";
  /** One-line advisory. */
  advisory: string;
};

const TRUSTED_META: TapTrustMeta = Object.freeze({
  level: "trusted",
  label: "Trusted",
  tone: "trusted",
  advisory: "Marked trusted by Hermes.",
});

const COMMUNITY_META: TapTrustMeta = Object.freeze({
  level: "community",
  label: "Community",
  tone: "caution",
  advisory:
    "From a community source. Review what a skill does before you install it.",
});

/** The trust badge for a tap. Community unless Hermes explicitly marked it
 * trusted. */
export function tapTrustMeta(tap: HermesSkillTapDto): TapTrustMeta {
  return tap.trusted ? TRUSTED_META : COMMUNITY_META;
}

/** Validates an `owner/repo` tap identifier. Mirrors the Rust `is_safe_tap_repo`:
 * exactly one `/`, each side starting with an alphanumeric (so a leading `-` can
 * never reach the CLI as a flag) then `[A-Za-z0-9._-]`, neither side `.`/`..`,
 * total length bounded. Returns a user-safe error message or null when valid. */
export function validateTapRepo(repo: string): string | null {
  const value = repo.trim();
  if (!value) return "Enter a tap repository as owner/repo.";
  if (value.length > 140) return "That repository name is too long.";
  const parts = value.split("/");
  if (parts.length !== 2) {
    return "Use the form owner/repo (for example acme/runbooks).";
  }
  const [owner, name] = parts;
  if (!isSafeTapSegment(owner) || !isSafeTapSegment(name)) {
    return "Only letters, numbers, dots, dashes, and underscores are allowed in owner/repo.";
  }
  return null;
}

/** True when one `owner`/`repo` segment is safe (see {@link validateTapRepo}). */
function isSafeTapSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") return false;
  if (!/^[A-Za-z0-9]/.test(segment)) return false;
  return /^[A-Za-z0-9._-]+$/.test(segment);
}

/** True when `repo` is a safe `owner/repo`. */
export function isSafeTapRepo(repo: string): boolean {
  return validateTapRepo(repo) === null;
}

/** Validates an optional path override. An empty/whitespace value means "use the
 * default" and is valid (the caller sends no override). A non-empty value must be
 * a relative path of `[A-Za-z0-9._-]` segments with no traversal (`..`), no
 * leading slash, and no shell metacharacter. Mirrors the Rust `is_safe_tap_path`
 * (a trailing slash is tolerated here and normalized away before the bridge sees
 * it). Returns a user-safe error message or null when valid. */
export function validateTapPath(path: string): string | null {
  const value = path.trim();
  if (!value) return null; // empty => default `skills/`
  if (value.length > 200) return "That path is too long.";
  if (value.startsWith("/") || value.startsWith("\\")) {
    return "Use a relative path inside the repository (no leading slash).";
  }
  const normalized = value.replace(/\/+$/, "");
  for (const segment of normalized.split("/")) {
    if (!segment || segment === "..") {
      return "The path cannot contain empty or .. segments.";
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      return "Only letters, numbers, dots, dashes, underscores, and slashes are allowed in the path.";
    }
  }
  return null;
}

/** Normalizes a path override for the bridge: trims, drops a trailing slash, and
 * returns undefined for an empty value (meaning "use the default `skills/`"). */
export function normalizeTapPath(path: string | undefined): string | undefined {
  const value = (path ?? "").trim().replace(/\/+$/, "");
  return value ? value : undefined;
}

/** The path label shown for a tap: its override, or the default. */
export function tapPathLabel(tap: HermesSkillTapDto): string {
  return tap.path && tap.path.trim() ? tap.path : DEFAULT_TAP_PATH;
}

/**
 * The Skills Hub `source` filter that scopes a search to one tap. The hub search
 * endpoint takes a `source` string; a tap's skills come from its GitHub repo, so
 * June scopes by the `owner/repo` identifier. The exact upstream source token is
 * not pinned in the v2026.6.19 contract, so this returns the repo verbatim and
 * the controller also filters the returned set locally by identifier prefix as a
 * safety net (see `use-skill-taps`).
 */
export function tapSearchSource(repo: string): string {
  return repo.trim();
}

/** True when a hub result appears to come from the given tap. Used to refine the
 * server-side `source` filter locally, since the upstream source token shape is
 * not pinned: a tap result's identifier or source typically contains the
 * `owner/repo`. */
export function hubResultMatchesTap(
  result: { identifier: string; source?: string },
  repo: string,
): boolean {
  const needle = repo.trim().toLowerCase();
  if (!needle) return true;
  const id = result.identifier.toLowerCase();
  const source = (result.source ?? "").toLowerCase();
  return id.includes(needle) || source.includes(needle);
}

/** Sorts taps by repo for a stable list. */
export function sortTaps(taps: HermesSkillTapDto[]): HermesSkillTapDto[] {
  return [...taps].sort((a, b) => a.repo.localeCompare(b.repo));
}

/** The env var name June configures for private taps / higher GitHub rate
 * limits. Used to wire the secret-setup UI and to recognise a rate-limit /
 * auth error as a token problem. */
export const TAP_GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

/** True when a tap CLI error message looks like a GitHub rate-limit or auth
 * failure, so June can steer the user to the GITHUB_TOKEN setup. Case-insensitive
 * substring match over the safe (already-redacted) message. */
export function looksLikeGithubAuthError(message: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("ratelimit") ||
    lower.includes("403") ||
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication") ||
    lower.includes("forbidden") ||
    lower.includes("not found") ||
    lower.includes("private") ||
    lower.includes("github_token") ||
    lower.includes("api rate")
  );
}
