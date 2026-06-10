import { useEffect, useMemo, useState } from "react";
import { setAgentRiskAcknowledged } from "../../lib/onboarding";
import { dictationSettings } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";
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
import { WelcomeStep } from "./steps/WelcomeSteps";
import { usePermissionStatuses } from "./use-permission-status";

type StepId =
  | "welcome"
  | "privacy"
  | "data-practices"
  | "permissions"
  | "setup"
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
  "Learn",
  "Finish",
] as const;

const STEPS: { id: StepId; stage: (typeof STAGES)[number] }[] = [
  { id: "welcome", stage: "Welcome" },
  { id: "privacy", stage: "Privacy" },
  { id: "data-practices", stage: "Privacy" },
  { id: "permissions", stage: "Permissions" },
  { id: "setup", stage: "Set up" },
  { id: "dictation-practice", stage: "Learn" },
  { id: "meeting-notes", stage: "Learn" },
  { id: "agent-intro", stage: "Learn" },
  { id: "agent-honesty", stage: "Learn" },
  { id: "finish", stage: "Finish" },
];

type Props = {
  account: AccountStatus;
  onComplete: () => void;
};

export function OnboardingFlow({ account, onComplete }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [shortcutLabel, setShortcutLabel] = useState("fn");
  const [language, setLanguage] = useState("");

  const step = STEPS[stepIndex];
  const stageIndex = STAGES.indexOf(step.stage);

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
    setStepIndex((index) => Math.max(index - 1, 0));
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
        {step.id === "welcome" ? (
          <WelcomeStep name={firstName} onContinue={goNext} />
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
