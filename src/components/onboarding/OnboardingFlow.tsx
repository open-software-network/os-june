import { useEffect, useMemo, useState } from "react";
import {
  onboardingResumeStep,
  setAgentRiskAcknowledged,
  setOnboardingResumeStep,
} from "../../lib/onboarding";
import { dictationSettings } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";
import { isSubscriptionActive } from "../../lib/trial-checkout";
import { FinishStep } from "./steps/FinishStep";
import {
  AgentStep,
  DictationPracticeStep,
  MeetingNotesStep,
} from "./steps/LearnSteps";
import { PermissionsStep } from "./steps/PermissionSteps";
import { PrivacyStep } from "./steps/PrivacySteps";
import { SignInStep } from "./steps/SignInStep";
import { TrialStep } from "./steps/TrialStep";
import { usePermissionStatuses } from "./use-permission-status";

type StepId =
  | "sign-in"
  | "privacy"
  | "permissions"
  | "trial"
  | "dictation-practice"
  | "meeting-notes"
  | "agent"
  | "finish";

// The trial sits after permissions (the user has invested) and right before
// the hands-on practice — which runs the real, metered pipeline and
// therefore needs the trial's credits. Pay, then immediately feel the payoff.
const STEPS: StepId[] = [
  "sign-in",
  "privacy",
  "permissions",
  "trial",
  "dictation-practice",
  "meeting-notes",
  "agent",
  "finish",
];

type Props = {
  account: AccountStatus;
  onAccountChanged: (next: AccountStatus) => void;
  onRefreshAccount: () => Promise<AccountStatus | undefined>;
  onComplete: () => void;
};

function initialStepIndex(): number {
  const saved = onboardingResumeStep();
  if (!saved) return 0;
  const index = STEPS.indexOf(saved as StepId);
  return index === -1 ? 0 : index;
}

export function OnboardingFlow({
  account,
  onAccountChanged,
  onRefreshAccount,
  onComplete,
}: Props) {
  const [stepIndex, setStepIndex] = useState(initialStepIndex);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [shortcutLabel, setShortcutLabel] = useState("fn");
  const [language, setLanguage] = useState("");

  const stepId = STEPS[stepIndex];

  // Everything past sign-in needs an account; a resume point past it with a
  // signed-out account (keychain cleared, signed out elsewhere) would strand
  // the user on steps that can't work.
  useEffect(() => {
    if (!account.signedIn && stepId !== "sign-in") {
      setStepIndex(0);
    }
  }, [account.signedIn, stepId]);

  useEffect(() => {
    setOnboardingResumeStep(stepId);
  }, [stepId]);

  // Only poll the helper while the user is on the permissions screen.
  const permissionStatuses = usePermissionStatuses(stepId === "permissions");

  useEffect(() => {
    dictationSettings()
      .then(({ settings }) => {
        if (settings.pushToTalkShortcut.label) {
          setShortcutLabel(settings.pushToTalkShortcut.label);
        }
        setLanguage(settings.language ?? "");
      })
      .catch(() => undefined);
  }, []);

  const firstName = useMemo(() => {
    const display = account.user?.displayName ?? account.user?.handle;
    return display?.split(/\s+/)[0];
  }, [account.user?.displayName, account.user?.handle]);

  function goNext() {
    setDirection("forward");
    setStepIndex((index) => Math.min(index + 1, STEPS.length - 1));
  }

  function goBack() {
    setDirection("back");
    setStepIndex((index) => {
      let next = Math.max(index - 1, 0);
      // The trial step auto-skips forward for subscribed users; stepping
      // back onto it would just bounce, so hop over it instead.
      if (STEPS[next] === "trial" && isSubscriptionActive(account)) {
        next = Math.max(next - 1, 0);
      }
      return next;
    });
  }

  return (
    <div className="onboarding-screen">
      <nav
        className="onboarding-progress"
        aria-label={`Setup progress: step ${stepIndex + 1} of ${STEPS.length}`}
      >
        {STEPS.map((id, index) => (
          <span
            key={id}
            className="onboarding-progress-seg"
            aria-hidden
            data-state={
              index < stepIndex
                ? "done"
                : index === stepIndex
                  ? "current"
                  : "upcoming"
            }
          />
        ))}
      </nav>
      <div className="onboarding-body" data-direction={direction}>
        {stepIndex > 0 ? (
          <button
            type="button"
            className="onboarding-back"
            onClick={goBack}
            aria-label="Back"
          >
            ← Back
          </button>
        ) : null}
        {stepId === "sign-in" ? (
          <SignInStep
            account={account}
            name={firstName}
            onAccountChanged={onAccountChanged}
            onContinue={goNext}
          />
        ) : stepId === "privacy" ? (
          <PrivacyStep onContinue={goNext} />
        ) : stepId === "permissions" ? (
          <PermissionsStep statuses={permissionStatuses} onContinue={goNext} />
        ) : stepId === "trial" ? (
          <TrialStep
            account={account}
            onRefresh={onRefreshAccount}
            onContinue={goNext}
          />
        ) : stepId === "dictation-practice" ? (
          <DictationPracticeStep
            name={firstName}
            shortcutLabel={shortcutLabel}
            onShortcutLabelChange={setShortcutLabel}
            language={language}
            onLanguageChange={setLanguage}
            onContinue={goNext}
          />
        ) : stepId === "meeting-notes" ? (
          <MeetingNotesStep onContinue={goNext} />
        ) : stepId === "agent" ? (
          <AgentStep
            onAcknowledged={() => setAgentRiskAcknowledged(true)}
            onContinue={goNext}
          />
        ) : (
          <FinishStep shortcutLabel={shortcutLabel} onComplete={onComplete} />
        )}
      </div>
    </div>
  );
}
