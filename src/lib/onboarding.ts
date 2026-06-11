/**
 * First-run onboarding state. Persisted in localStorage (like the theme
 * preference) rather than the backend: it's per-machine UI state, and the
 * wizard must render before the app bootstraps, so it can't depend on a
 * backend round-trip. Bump ONBOARDING_VERSION to re-run the wizard for
 * everyone after a flow redesign.
 */

const ONBOARDING_VERSION = 4;
const COMPLETED_KEY = "june.onboarding.completedVersion";
const RESUME_KEY = "june.onboarding.resumeStep";
const AGENT_ACK_KEY = "june.agent.riskAcknowledged";

type OnboardingReplayEnv = {
  readonly DEV?: boolean;
  readonly VITE_JUNE_REPLAY_ONBOARDING?: string;
};

export function applyOnboardingReplayFlag(
  env: OnboardingReplayEnv = import.meta.env,
) {
  if (shouldReplayOnboarding(env)) {
    resetOnboardingForReplay();
  }
}

export function shouldReplayOnboarding(
  env: OnboardingReplayEnv = import.meta.env,
) {
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

export function markOnboardingComplete() {
  try {
    window.localStorage.setItem(COMPLETED_KEY, String(ONBOARDING_VERSION));
    window.localStorage.removeItem(RESUME_KEY);
  } catch {
    // Ignore; worst case the wizard shows again next launch.
  }
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
 * Resume point for a wizard quit partway through (e.g. mid free-trial
 * checkout). A relaunch picks up at the saved step instead of replaying the
 * whole flow — steps re-verify their own state, so resuming "too far" is
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
