/**
 * First-run onboarding state. Persisted in localStorage (like the theme
 * preference) rather than the backend: it's per-machine UI state, and the
 * wizard must render before the app bootstraps, so it can't depend on a
 * backend round-trip. Bump ONBOARDING_VERSION to re-run the wizard for
 * everyone after a flow redesign.
 */

const ONBOARDING_VERSION = 3;
const COMPLETED_KEY = "june.onboarding.completedVersion";
const AGENT_ACK_KEY = "june.agent.riskAcknowledged";

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
  } catch {
    // Ignore; worst case the wizard shows again next launch.
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
