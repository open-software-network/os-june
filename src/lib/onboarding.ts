/**
 * First-run onboarding state. Persisted in localStorage (like the theme
 * preference) rather than the backend: it's per-machine UI state, and the
 * wizard must render before the app bootstraps, so it can't depend on a
 * backend round-trip. Bump ONBOARDING_VERSION to re-run the wizard for
 * everyone after a flow redesign.
 */

const ONBOARDING_VERSION = 2;
const COMPLETED_KEY = "june.onboarding.completedVersion";
const PROFILE_KEY = "june.onboarding.profile";
const DATA_SHARING_KEY = "june.privacy.shareUsageData";
const AGENT_ACK_KEY = "june.agent.riskAcknowledged";

export type OnboardingProfile = {
  focus: string[];
};

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

export function loadOnboardingProfile(): OnboardingProfile {
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    if (!raw) return { focus: [] };
    const parsed = JSON.parse(raw) as Partial<OnboardingProfile>;
    return {
      focus: Array.isArray(parsed.focus)
        ? parsed.focus.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    };
  } catch {
    return { focus: [] };
  }
}

export function saveOnboardingProfile(profile: OnboardingProfile) {
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore; the profile only personalizes copy.
  }
}

/** Usage-analytics opt-in. Private by default: absent means false. */
export function isDataSharingEnabled(): boolean {
  try {
    return window.localStorage.getItem(DATA_SHARING_KEY) === "true";
  } catch {
    return false;
  }
}

export function setDataSharingEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(DATA_SHARING_KEY, String(enabled));
  } catch {
    // Ignore.
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
