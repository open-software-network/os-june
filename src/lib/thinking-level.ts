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
 * - Low -> "minimal": the model barely deliberates, so first tokens arrive
 *   quickly.
 * - Medium -> "medium": Hermes' own default; a balance of speed and depth.
 * - High -> "high": substantially more reasoning for harder problems.
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
    label: "Low",
    blurb: "Faster responses with lower usage.",
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
    label: "High",
    blurb: "Deeper reasoning with higher usage.",
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

export function thinkingOptionForLevel(level: ThinkingLevel): ThinkingLevelOption {
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
 * by session.info) back onto a level. `none`, `minimal`, and `low` display as
 * Low; `high` and `xhigh` display as High. Unknown/empty values let callers keep
 * their current draft instead of snapping to a stop. */
export function thinkingLevelForEffort(effort: string | undefined): ThinkingLevel | undefined {
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

/**
 * Per-session record of each chat's reasoning effort, mirroring
 * agent-session-modes.ts: machine-local (like the runtime's own session
 * store) and readable synchronously on render. This is what lets the
 * composer show the level a session actually runs at — its creation pin, a
 * pick made while it was open, or the effort its live runtime last reported
 * via session.info — instead of guessing from the machine-wide draft.
 */

const SESSION_LEVELS_STORAGE_KEY = "june.agent.sessionThinkingLevels";

function readSessionLevelsStore(): Record<string, ThinkingLevel> {
  try {
    const raw = window.localStorage.getItem(SESSION_LEVELS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const store: Record<string, ThinkingLevel> = {};
    for (const [sessionId, level] of Object.entries(parsed)) {
      if (isThinkingLevel(level)) store[sessionId] = level;
    }
    return store;
  } catch {
    return {};
  }
}

function writeSessionLevelsStore(store: Record<string, ThinkingLevel>) {
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(SESSION_LEVELS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SESSION_LEVELS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore; worst case a session shows the draft until its runtime reports.
  }
}

/** Every session's best-known effort, keyed by stored session id. */
export function loadSessionThinkingLevels(): Record<string, ThinkingLevel> {
  return readSessionLevelsStore();
}

export function rememberSessionThinkingLevel(sessionId: string, level: ThinkingLevel) {
  const store = readSessionLevelsStore();
  store[sessionId] = level;
  writeSessionLevelsStore(store);
}

export function forgetSessionThinkingLevel(sessionId: string) {
  const store = readSessionLevelsStore();
  if (!(sessionId in store)) return;
  delete store[sessionId];
  writeSessionLevelsStore(store);
}
