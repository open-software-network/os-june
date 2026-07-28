/**
 * First-run onboarding state. Persisted in localStorage (like the theme
 * preference) rather than the backend: it's per-machine UI state, and the
 * wizard must render before the app bootstraps, so it can't depend on a
 * backend round-trip. Bump ONBOARDING_VERSION to re-run the wizard for
 * everyone after a flow redesign.
 */

const ONBOARDING_VERSION = 9;
const COMPLETED_KEY = "june.onboarding.completedVersion";
const RESUME_KEY = "june.onboarding.resumeStep.v2";
const LEGACY_RESUME_KEY = "june.onboarding.resumeStep";
const AGENT_ACK_KEY = "june.agent.riskAcknowledged";
const AREA_KEY = "june.onboarding.area";
const PERSONALITY_KEY = "june.onboarding.personality";
const USE_CASES_KEY = "june.onboarding.useCases";
const CUSTOM_USE_CASE_KEY = "june.onboarding.customUseCase";
const ONBOARDING_BROADCAST_CHANNEL = "june.onboarding";

export const ONBOARDING_COMPLETED_EVENT = "june:onboarding-completed";
export const ONBOARDING_USE_CASES = [
  "work",
  "personal",
  "school",
  "creative",
  "coding",
  "meetings",
  "other",
  "not-sure",
] as const;

export type OnboardingUseCase = (typeof ONBOARDING_USE_CASES)[number];

const ONBOARDING_USE_CASE_SET = new Set<string>(ONBOARDING_USE_CASES);

export const ONBOARDING_AREAS = ["work", "personal", "thinking", "play"] as const;
export type OnboardingArea = (typeof ONBOARDING_AREAS)[number];

export type OnboardingPersonality = {
  voice: number;
  detail: number;
  initiative: number;
  humor: number;
};

export type OnboardingHomeRoute = {
  firstAction: string;
  immediateOutput: string;
  retainedBehavior: string;
};

const ONBOARDING_AREA_SET = new Set<string>(ONBOARDING_AREAS);

const LEGACY_VOICE_VALUES: Record<string, number> = {
  professional: 0,
  natural: 50,
  relaxed: 100,
};
const LEGACY_DETAIL_VALUES: Record<string, number> = {
  concise: 0,
  balanced: 50,
  thorough: 100,
};
const LEGACY_INITIATIVE_VALUES: Record<string, number> = {
  "answer-only": 0,
  "suggest-next": 100,
};
const LEGACY_HUMOR_VALUES: Record<string, number> = {
  serious: 0,
  playful: 50,
  funny: 100,
};

function isSpectrumValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function spectrumValue(
  value: unknown,
  fallback: number,
  legacyValues: Record<string, number>,
): number {
  if (isSpectrumValue(value)) return value;
  if (typeof value === "string" && value in legacyValues) return legacyValues[value];
  return fallback;
}

export const ONBOARDING_PERSONALITY_PRESETS: Record<OnboardingArea, OnboardingPersonality> = {
  work: {
    voice: 10,
    detail: 40,
    initiative: 85,
    humor: 20,
  },
  personal: {
    voice: 80,
    detail: 55,
    initiative: 70,
    humor: 45,
  },
  thinking: {
    voice: 45,
    detail: 90,
    initiative: 75,
    humor: 20,
  },
  play: {
    voice: 85,
    detail: 70,
    initiative: 80,
    humor: 95,
  },
};

/**
 * The routing contract for the Home follow-up. Onboarding persists the area
 * now; Home can consume this map when its first-run recommendation is built.
 */
export const ONBOARDING_HOME_ROUTES: Record<OnboardingArea, OnboardingHomeRoute> = {
  work: {
    firstAction: "Record a meeting or dictate a follow-up",
    immediateOutput: "A clean summary, decisions, and follow-ups",
    retainedBehavior: "Capture the next meeting and clear follow-ups from Home",
  },
  personal: {
    firstAction: "Talk through something on your mind",
    immediateOutput: "A private journal entry with the thoughts worth keeping",
    retainedBehavior: "Return to Home for spoken notes, plans, and decisions",
  },
  thinking: {
    firstAction: "Talk through a rough idea, decision, or reflection",
    immediateOutput: "A clearer structure, draft, or perspective",
    retainedBehavior: "Use dictation and Home to think, write, and reflect",
  },
  play: {
    firstAction: "Create a character and start a role-play",
    immediateOutput: "A character, setting, and first scene to jump into",
    retainedBehavior: "Return to Home to continue the story or invent a new world",
  },
};

type OnboardingReplayEnv = {
  readonly DEV?: boolean;
  readonly VITE_JUNE_REPLAY_ONBOARDING?: string;
};

export function applyOnboardingReplayFlag(env: OnboardingReplayEnv = import.meta.env) {
  if (shouldReplayOnboarding(env)) {
    resetOnboardingForReplay();
  }
}

export function shouldReplayOnboarding(env: OnboardingReplayEnv = import.meta.env) {
  return env.DEV === true && env.VITE_JUNE_REPLAY_ONBOARDING === "1";
}

export function isOnboardingComplete(): boolean {
  try {
    const raw = window.localStorage.getItem(COMPLETED_KEY);
    return raw !== null && Number(raw) >= ONBOARDING_VERSION;
  } catch {
    // Storage unavailable: never trap the user in the wizard.
    return true;
  }
}

/** Whether this machine has ever finished onboarding, at any version.
 * Distinguishes a genuinely fresh install from a wizard replay after an
 * ONBOARDING_VERSION bump, so one-time first-run defaults (like enabling
 * launch at login) never re-apply to existing users. */
export function hasCompletedAnyOnboardingVersion(): boolean {
  try {
    return window.localStorage.getItem(COMPLETED_KEY) !== null;
  } catch {
    // Storage unavailable reads as "not a fresh install": err on the side
    // of not applying first-run defaults.
    return true;
  }
}

export function markOnboardingComplete() {
  try {
    window.localStorage.setItem(COMPLETED_KEY, String(ONBOARDING_VERSION));
    window.localStorage.removeItem(RESUME_KEY);
    window.localStorage.removeItem(LEGACY_RESUME_KEY);
  } catch {
    // Ignore; worst case the wizard shows again next launch.
  }
  notifyOnboardingComplete();
}

export function resetOnboardingForReplay() {
  try {
    window.localStorage.removeItem(COMPLETED_KEY);
    window.localStorage.removeItem(RESUME_KEY);
    window.localStorage.removeItem(LEGACY_RESUME_KEY);
  } catch {
    // Ignore; storage unavailable already behaves like a completed wizard.
  }
}

/**
 * Run `callback` once when onboarding completes, then stop. Onboarding
 * completes a single time per install, and in a Tauri sibling window (the HUD)
 * the storage event and the BroadcastChannel message both fire for the same
 * completion. The `delivered` guard collapses those into one invocation so the
 * subscription is at-most-once regardless of how many signals arrive.
 */
export function subscribeToOnboardingComplete(callback: () => void) {
  let delivered = false;
  const fireOnce = () => {
    if (delivered) return;
    delivered = true;
    callback();
  };
  const onLocalComplete = () => fireOnce();
  const onStorage = (event: StorageEvent) => {
    if (event.key === COMPLETED_KEY && isOnboardingComplete()) fireOnce();
  };

  window.addEventListener(ONBOARDING_COMPLETED_EVENT, onLocalComplete);
  window.addEventListener("storage", onStorage);

  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(ONBOARDING_BROADCAST_CHANNEL);
    channel.addEventListener("message", onLocalComplete);
  } catch {
    // BroadcastChannel is best-effort; storage still reaches sibling windows.
  }

  return () => {
    window.removeEventListener(ONBOARDING_COMPLETED_EVENT, onLocalComplete);
    window.removeEventListener("storage", onStorage);
    channel?.removeEventListener("message", onLocalComplete);
    channel?.close();
  };
}

function notifyOnboardingComplete() {
  window.dispatchEvent(new Event(ONBOARDING_COMPLETED_EVENT));
  try {
    const channel = new BroadcastChannel(ONBOARDING_BROADCAST_CHANNEL);
    channel.postMessage({ type: "completed" });
    channel.close();
  } catch {
    // Ignore; the localStorage write above is enough for persisted state.
  }
}

/**
 * Resume point for a wizard quit partway through. A relaunch picks up at the
 * saved step instead of replaying the whole flow. The storage key is versioned
 * with the step sequence so a reordered flow starts from its first reachable
 * step instead of skipping newly earlier setup. Returns the saved step id, or
 * null for a fresh run.
 */
export function onboardingResumeStep(): string | null {
  try {
    return window.localStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
}

export function setOnboardingResumeStep(stepId: string) {
  try {
    window.localStorage.setItem(RESUME_KEY, stepId);
  } catch {
    // Ignore; worst case the wizard restarts from the top.
  }
}

export function onboardingArea(): OnboardingArea | null {
  try {
    const value = window.localStorage.getItem(AREA_KEY);
    return value && ONBOARDING_AREA_SET.has(value) ? (value as OnboardingArea) : null;
  } catch {
    return null;
  }
}

export function saveOnboardingArea(area: OnboardingArea) {
  try {
    if (!ONBOARDING_AREA_SET.has(area)) return;
    window.localStorage.setItem(AREA_KEY, area);
  } catch {
    // Ignore; this preference can be chosen again if storage is unavailable.
  }
}

export function personalityPresetForArea(area: OnboardingArea): OnboardingPersonality {
  return { ...ONBOARDING_PERSONALITY_PRESETS[area] };
}

export function onboardingPersonality(
  fallbackArea: OnboardingArea = "work",
): OnboardingPersonality {
  const fallback = personalityPresetForArea(fallbackArea);
  try {
    const raw = window.localStorage.getItem(PERSONALITY_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      voice: spectrumValue(parsed.voice, fallback.voice, LEGACY_VOICE_VALUES),
      detail: spectrumValue(parsed.detail, fallback.detail, LEGACY_DETAIL_VALUES),
      initiative: spectrumValue(parsed.initiative, fallback.initiative, LEGACY_INITIATIVE_VALUES),
      humor: spectrumValue(parsed.humor, fallback.humor, LEGACY_HUMOR_VALUES),
    };
  } catch {
    return fallback;
  }
}

export function saveOnboardingPersonality(personality: OnboardingPersonality) {
  try {
    if (
      !isSpectrumValue(personality.voice) ||
      !isSpectrumValue(personality.detail) ||
      !isSpectrumValue(personality.initiative) ||
      !isSpectrumValue(personality.humor)
    ) {
      return;
    }
    window.localStorage.setItem(PERSONALITY_KEY, JSON.stringify(personality));
  } catch {
    // Ignore; the preset remains available if storage is unavailable.
  }
}

export function onboardingUseCases(): OnboardingUseCase[] {
  try {
    const raw = window.localStorage.getItem(USE_CASES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const deduped = new Set(
      parsed.filter((value): value is OnboardingUseCase => {
        return typeof value === "string" && ONBOARDING_USE_CASE_SET.has(value);
      }),
    );
    return ONBOARDING_USE_CASES.filter((useCase) => deduped.has(useCase));
  } catch {
    return [];
  }
}

export function saveOnboardingUseCases(useCases: readonly OnboardingUseCase[]) {
  try {
    const deduped = new Set(
      useCases.filter((value): value is OnboardingUseCase => {
        return ONBOARDING_USE_CASE_SET.has(value);
      }),
    );
    const ordered = ONBOARDING_USE_CASES.filter((useCase) => deduped.has(useCase));
    window.localStorage.setItem(USE_CASES_KEY, JSON.stringify(ordered));
  } catch {
    // Ignore; this is product metadata, not a completion gate.
  }
}

export function onboardingCustomUseCase(): string {
  try {
    return sanitizeCustomUseCase(window.localStorage.getItem(CUSTOM_USE_CASE_KEY) ?? "");
  } catch {
    return "";
  }
}

export function saveOnboardingCustomUseCase(customUseCase: string) {
  try {
    const sanitized = sanitizeCustomUseCase(customUseCase);
    if (sanitized) {
      window.localStorage.setItem(CUSTOM_USE_CASE_KEY, sanitized);
    } else {
      window.localStorage.removeItem(CUSTOM_USE_CASE_KEY);
    }
  } catch {
    // Ignore; this is product metadata, not a completion gate.
  }
}

function sanitizeCustomUseCase(customUseCase: string): string {
  return customUseCase.trim().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * The onboarding honesty screen's acknowledgment that the agent can make
 * mistakes and the user stays the approval step. Surfaces for future use
 * by the agent workspace (e.g. re-prompt if never acknowledged).
 */
export function isAgentRiskAcknowledged(): boolean {
  try {
    return window.localStorage.getItem(AGENT_ACK_KEY) === "true";
  } catch {
    return false;
  }
}

export function setAgentRiskAcknowledged(acknowledged: boolean) {
  try {
    window.localStorage.setItem(AGENT_ACK_KEY, String(acknowledged));
  } catch {
    // Ignore.
  }
}

/**
 * Testing helper: forget that onboarding completed (optionally pinning the
 * step to land on, e.g. "permissions") and reload into the wizard. Exposed on the
 * devtools console as `june.replayOnboarding()` by main.tsx.
 */
export function replayOnboarding(stepId?: string) {
  try {
    window.localStorage.removeItem(COMPLETED_KEY);
    if (stepId) window.localStorage.setItem(RESUME_KEY, stepId);
    else window.localStorage.removeItem(RESUME_KEY);
  } catch {
    // Storage unavailable: the wizard already replays every launch.
  }
  window.location.reload();
}
