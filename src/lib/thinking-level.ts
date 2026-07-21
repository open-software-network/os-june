/**
 * The composer's thinking level control: how much June reasons before
 * answering. It lives in the model menu as an "Effort" row with a submenu of
 * three levels, mirroring the upstream desktop's model menu.
 *
 * Three user-facing stops map onto Hermes' reasoning-effort levels
 * (`parse_reasoning_effort` in hermes_constants.py: none, minimal, low,
 * medium, high, xhigh). June deliberately exposes only three of them so the
 * choice stays a simple speed/depth tradeoff:
 *
 * - Instant -> "minimal": the model barely deliberates, so first tokens
 *   arrive almost immediately.
 * - Medium -> "medium": Hermes' own default; a balance of speed and depth.
 * - Hard -> "high": substantially more reasoning for harder problems.
 *
 * The choice rides to Hermes as a PER-SESSION override (`reasoning_effort`
 * on session.create, `config.set` key "reasoning" for a live session), so
 * June never has to rely on the profile config default. The user's last pick
 * is kept in localStorage as the draft for the next new session, mirroring
 * how agent-session-modes.ts records the Unrestricted opt-in (machine-local
 * state, readable synchronously on render).
 */

export type ThinkingLevel = "instant" | "medium" | "hard";

export type ThinkingLevelOption = {
  id: ThinkingLevel;
  /** Sentence-case label rendered on the submenu row. */
  label: string;
  /** One-line description of the tradeoff, no dashes (project copy rule). */
  blurb: string;
  /** The Hermes reasoning-effort string sent on the wire. */
  effort: string;
};

/** Slider stops in track order (left to right: fastest to deepest). */
export const THINKING_LEVELS: readonly ThinkingLevelOption[] = Object.freeze([
  {
    id: "instant",
    label: "Instant",
    blurb: "Answers right away, with very little deliberation.",
    effort: "minimal",
  },
  {
    id: "medium",
    label: "Medium",
    blurb: "Balances speed and depth for most tasks.",
    effort: "medium",
  },
  {
    id: "hard",
    label: "Hard",
    blurb: "Spends more time reasoning through hard problems.",
    effort: "high",
  },
]);

/** The control lands here when the user has never picked a level. Matches
 * Hermes' own default effort, so a fresh install behaves like upstream. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const STORAGE_KEY = "june.agent.thinkingLevel";

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "instant" || value === "medium" || value === "hard";
}

export function thinkingOptionForLevel(
  level: ThinkingLevel,
): ThinkingLevelOption {
  const option = THINKING_LEVELS.find((entry) => entry.id === level);
  // The union has exactly one option per level; the find cannot miss. The
  // fallback keeps a corrupt future edit from crashing the composer.
  return option ?? THINKING_LEVELS[1];
}

/** The wire value Hermes expects for this level (`reasoning_effort`). */
export function thinkingEffortForLevel(level: ThinkingLevel): string {
  return thinkingOptionForLevel(level).effort;
}

/** Best-effort reverse mapping from a Hermes effort string (e.g. one reported
 * by session.info) back onto a level. Low collapses into Instant and
 * xhigh into Hard; unknown/empty values return undefined so callers can keep
 * their current draft instead of snapping to a stop. */
export function thinkingLevelForEffort(
  effort: string | undefined,
): ThinkingLevel | undefined {
  switch ((effort ?? "").trim().toLowerCase()) {
    case "none":
    case "minimal":
    case "low":
      return "instant";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "hard";
    default:
      return undefined;
  }
}

/** The stored draft level for the next new session; the default when nothing
 * (or something unreadable) was stored. */
export function loadThinkingLevel(): ThinkingLevel {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThinkingLevel(raw) ? raw : DEFAULT_THINKING_LEVEL;
  } catch {
    return DEFAULT_THINKING_LEVEL;
  }
}

export function saveThinkingLevel(level: ThinkingLevel) {
  try {
    window.localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Ignore; worst case the next launch drafts the default again.
  }
}
