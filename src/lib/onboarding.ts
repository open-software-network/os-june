/**
 * First-run onboarding state. Persisted in localStorage (like the theme
 * preference) rather than the backend: it's per-machine UI state, and the
 * wizard must render before the app bootstraps, so it can't depend on a
 * backend round-trip. Bump ONBOARDING_VERSION to re-run the wizard for
 * everyone after a flow redesign.
 */

const ONBOARDING_VERSION = 7;
const COMPLETED_KEY = "june.onboarding.completedVersion";
const RESUME_KEY = "june.onboarding.resumeStep";
const AGENT_ACK_KEY = "june.agent.riskAcknowledged";
const DISCOVERY_KEY = "june.onboarding.discoverySource";
const DISCOVERY_REPORTED_KEY = "june.onboarding.discoveryReported";
const DISCOVERY_PENDING_REPORT_KEY = "june.onboarding.discoveryPendingReport";

const discoveryReportsInFlight = new Set<string>();

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
    // Dev-only path: forget the discovery answer too, so the replayed
    // wizard shows the whole flow. Real version-bump replays don't come
    // through here and keep it.
    window.localStorage.removeItem(DISCOVERY_KEY);
    window.localStorage.removeItem(DISCOVERY_REPORTED_KEY);
    window.localStorage.removeItem(DISCOVERY_PENDING_REPORT_KEY);
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
 * Where the user says they discovered June, asked once at the end of the
 * wizard. A non-null answer is never re-asked, even when a version bump
 * replays the wizard. Stored locally first, then reported only when the user
 * leaves the final onboarding step.
 */
export function discoverySource(): string | null {
  try {
    return window.localStorage.getItem(DISCOVERY_KEY);
  } catch {
    return null;
  }
}

export function setDiscoverySource(source: string) {
  try {
    window.localStorage.setItem(DISCOVERY_KEY, source);
    window.localStorage.removeItem(DISCOVERY_REPORTED_KEY);
    window.localStorage.removeItem(DISCOVERY_PENDING_REPORT_KEY);
  } catch {
    // Ignore; worst case the question is asked again on a replay.
  }
}

export function reportPendingDiscoverySource(options?: { force?: boolean }) {
  const source = discoverySource();
  if (source && (options?.force || discoveryPendingReport() === source)) {
    reportDiscoverySource(source, { markPending: options?.force === true });
  }
}

function reportDiscoverySource(
  source: string,
  options?: { markPending?: boolean },
) {
  const normalized = source.trim();
  if (!normalized || discoveryReportStatus() === normalized) {
    return;
  }
  if (options?.markPending) {
    try {
      window.localStorage.setItem(DISCOVERY_PENDING_REPORT_KEY, normalized);
    } catch {
      // Ignore; a best-effort in-flight send still happens.
    }
  }
  if (discoveryReportsInFlight.has(normalized)) {
    return;
  }
  discoveryReportsInFlight.add(normalized);
  void import("./tauri")
    .then(({ submitDiscoverySource }) =>
      submitDiscoverySource({ source: normalized }),
    )
    .then((response) => {
      if (!response.received) return;
      try {
        if (discoverySource() === normalized) {
          window.localStorage.setItem(DISCOVERY_REPORTED_KEY, normalized);
          window.localStorage.removeItem(DISCOVERY_PENDING_REPORT_KEY);
        }
      } catch {
        // Ignore; retrying later is harmless.
      }
    })
    .catch(() => undefined)
    .finally(() => {
      discoveryReportsInFlight.delete(normalized);
    });
}

function discoveryReportStatus(): string | null {
  try {
    return window.localStorage.getItem(DISCOVERY_REPORTED_KEY);
  } catch {
    return null;
  }
}

function discoveryPendingReport(): string | null {
  try {
    return window.localStorage.getItem(DISCOVERY_PENDING_REPORT_KEY);
  } catch {
    return null;
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

/**
 * Testing helper: forget that onboarding completed (optionally pinning the
 * step to land on, e.g. "trial") and reload into the wizard. Exposed on the
 * devtools console as `june.replayOnboarding()` by main.tsx.
 */
export function replayOnboarding(stepId?: string) {
  try {
    window.localStorage.removeItem(COMPLETED_KEY);
    window.localStorage.removeItem(DISCOVERY_KEY);
    window.localStorage.removeItem(DISCOVERY_REPORTED_KEY);
    window.localStorage.removeItem(DISCOVERY_PENDING_REPORT_KEY);
    if (stepId) window.localStorage.setItem(RESUME_KEY, stepId);
    else window.localStorage.removeItem(RESUME_KEY);
  } catch {
    // Storage unavailable: the wizard already replays every launch.
  }
  window.location.reload();
}
