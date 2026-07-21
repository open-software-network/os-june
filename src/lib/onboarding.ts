/**
 * First-run onboarding state. Persisted in localStorage (like the theme
 * preference) rather than the backend: it's per-machine UI state, and the
 * wizard must render before the app bootstraps, so it can't depend on a
 * backend round-trip. Bump ONBOARDING_VERSION to re-run the wizard for
 * everyone after a flow redesign.
 */

const ONBOARDING_VERSION = 8;
const COMPLETED_KEY = "june.onboarding.completedVersion";
const RESUME_KEY = "june.onboarding.resumeStep";
const AGENT_ACK_KEY = "june.agent.riskAcknowledged";
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
  } catch {
    // Ignore; worst case the wizard shows again next launch.
  }
  notifyOnboardingComplete();
}

export function resetOnboardingForReplay() {
  try {
    window.localStorage.removeItem(COMPLETED_KEY);
    window.localStorage.removeItem(RESUME_KEY);
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
 * saved step instead of replaying the whole flow — steps re-verify their own
 * state, so resuming "too far" is
 * harmless. Returns the saved step id, or null for a fresh run.
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
