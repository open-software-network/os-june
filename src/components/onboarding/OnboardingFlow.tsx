import { useEffect, useMemo, useState } from "react";
import {
  onboardingResumeStep,
  setAgentRiskAcknowledged,
  setOnboardingResumeStep,
} from "../../lib/onboarding";
import { dictationSettings } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";
import { hasPlanCredits } from "../../lib/account-gate";
import { isSubscriptionActive } from "../../lib/trial-checkout";
import { FinishStep } from "./steps/FinishStep";
import {
  AgentHonestyStep,
  AgentIntroStep,
  DictationPracticeStep,
  MeetingNotesStep,
} from "./steps/LearnSteps";
import { PermissionsStep } from "./steps/PermissionSteps";
import { DataPracticesStep, PrivacyStep } from "./steps/PrivacySteps";
import { SetupStep } from "./steps/SetupStep";
import { SignInStep } from "./steps/SignInStep";
import { TrialStep } from "./steps/TrialStep";
import { usePermissionStatuses } from "./use-permission-status";

type StepId =
  | "sign-in"
  | "privacy"
  | "data-practices"
  | "permissions"
  | "setup"
  | "trial"
  | "dictation-practice"
  | "meeting-notes"
  | "agent-intro"
  | "agent-honesty"
  | "finish";

const STAGES = [
  "Welcome",
  "Privacy",
  "Permissions",
  "Set up",
  "Free trial",
  "Learn",
  "Finish",
] as const;

// The trial sits after permissions/setup (the user has invested) and right
// before the hands-on practice — which runs the real, metered pipeline and
// therefore needs the trial's credits. Pay, then immediately feel the payoff.
const STEPS: { id: StepId; stage: (typeof STAGES)[number] }[] = [
  { id: "sign-in", stage: "Welcome" },
  { id: "privacy", stage: "Privacy" },
  { id: "data-practices", stage: "Privacy" },
  { id: "permissions", stage: "Permissions" },
  { id: "setup", stage: "Set up" },
  { id: "trial", stage: "Free trial" },
  { id: "dictation-practice", stage: "Learn" },
  { id: "meeting-notes", stage: "Learn" },
  { id: "agent-intro", stage: "Learn" },
  { id: "agent-honesty", stage: "Learn" },
  { id: "finish", stage: "Finish" },
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
  const index = STEPS.findIndex((step) => step.id === saved);
  return index === -1 ? 0 : index;
}

export function OnboardingFlow({
  account,
  onAccountChanged,
  onRefreshAccount,
  onComplete,
}: Props) {
  const [stepIndex, setStepIndex] = useState(initialStepIndex);
  const [shortcutLabel, setShortcutLabel] = useState("fn");
  const [language, setLanguage] = useState("");

  const step = STEPS[stepIndex];
  const stageIndex = STAGES.indexOf(step.stage);

  // Everything past sign-in needs an account; a resume point past it with a
  // signed-out account (keychain cleared, signed out elsewhere) would strand
  // the user on steps that can't work.
  useEffect(() => {
    if (!account.signedIn && step.id !== "sign-in") {
      setStepIndex(0);
    }
  }, [account.signedIn, step.id]);

  useEffect(() => {
    setOnboardingResumeStep(step.id);
  }, [step.id]);

  // Only poll the helper while the user is on the permissions screen.
  const permissionStatuses = usePermissionStatuses(step.id === "permissions");

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
    setStepIndex((index) => Math.min(index + 1, STEPS.length - 1));
  }

  function goBack() {
    setStepIndex((index) => {
      let next = Math.max(index - 1, 0);
      // The trial step auto-skips forward for users who already have access
      // (subscription or plan credits); stepping back onto it would just
      // bounce, so hop over it instead.
      if (
        STEPS[next].id === "trial" &&
        (isSubscriptionActive(account) || hasPlanCredits(account))
      ) {
        next = Math.max(next - 1, 0);
      }
      return next;
    });
  }

  return (
    <div className="onboarding-screen">
      <nav className="onboarding-progress" aria-label="Setup progress">
        {STAGES.map((stage, index) => (
          <span
            key={stage}
            className="onboarding-progress-stage"
            data-state={
              index < stageIndex
                ? "done"
                : index === stageIndex
                  ? "current"
                  : "upcoming"
            }
            aria-current={index === stageIndex ? "step" : undefined}
          >
            {stage}
          </span>
        ))}
      </nav>
      <div className="onboarding-body">
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
        {step.id === "sign-in" ? (
          <SignInStep
            account={account}
            name={firstName}
            onAccountChanged={onAccountChanged}
            onContinue={goNext}
          />
        ) : step.id === "privacy" ? (
          <PrivacyStep onContinue={goNext} />
        ) : step.id === "data-practices" ? (
          <DataPracticesStep onContinue={goNext} />
        ) : step.id === "permissions" ? (
          <PermissionsStep statuses={permissionStatuses} onContinue={goNext} />
        ) : step.id === "setup" ? (
          <SetupStep
            shortcutLabel={shortcutLabel}
            onShortcutLabelChange={setShortcutLabel}
            language={language}
            onLanguageChange={setLanguage}
            onContinue={goNext}
          />
        ) : step.id === "trial" ? (
          <TrialStep
            account={account}
            onRefresh={onRefreshAccount}
            onContinue={goNext}
          />
        ) : step.id === "dictation-practice" ? (
          <DictationPracticeStep
            name={firstName}
            shortcutLabel={shortcutLabel}
            onContinue={goNext}
          />
        ) : step.id === "meeting-notes" ? (
          <MeetingNotesStep onContinue={goNext} />
        ) : step.id === "agent-intro" ? (
          <AgentIntroStep onContinue={goNext} />
        ) : step.id === "agent-honesty" ? (
          <AgentHonestyStep
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
