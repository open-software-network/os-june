import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { useEffect, useMemo, useState } from "react";
import { onboardingResumeStep, setOnboardingResumeStep } from "../../lib/onboarding";
import { isMacLikePlatform } from "../../lib/platform";
import { dictationSettings, p3aRecord, setDictationShortcut } from "../../lib/tauri";
import type { AccountStatus, DictationShortcutSetting } from "../../lib/tauri";
import { PermissionsStep } from "./steps/PermissionSteps";
import { DictationPracticeStep } from "./steps/PracticeStep";
import { SignInStep } from "./steps/SignInStep";
import { TelemetryConsentStep } from "./steps/TelemetryConsentStep";
import { usePermissionStatuses, useSystemAudioStatus } from "./use-permission-status";

type StepId = "sign-in" | "telemetry" | "permissions" | "dictation-practice";

// The product default: bare fn, mirroring DictationShortcutSetting::bare_fn()
// on the Rust side.
const FN_SHORTCUT = {
  code: "Fn",
  modifiers: {
    command: false,
    control: false,
    option: false,
    shift: false,
    function: true,
  },
  label: "Fn",
  pressCount: 1 as const,
};

// Mirrors DictationShortcutSetting::control_option_d() on the Rust side: the
// factory default a fresh install carries before anyone has touched it.
function isFactoryDefaultShortcut(shortcut: DictationShortcutSetting) {
  return (
    shortcut.code === "KeyD" &&
    shortcut.modifiers.control &&
    shortcut.modifiers.option &&
    !shortcut.modifiers.command &&
    !shortcut.modifiers.shift &&
    !shortcut.modifiers.function
  );
}

const MAC_STEPS: StepId[] = ["sign-in", "telemetry", "permissions", "dictation-practice"];
const NON_MAC_STEPS: StepId[] = ["sign-in", "telemetry", "permissions"];

type Props = {
  account: AccountStatus;
  onAccountChanged: (next: AccountStatus) => void;
  onComplete: () => void;
};

function initialStepIndex(steps: StepId[]): number {
  const demoStep = browserOnboardingDemoStep();
  if (demoStep) {
    const demoIndex = steps.indexOf(demoStep);
    if (demoIndex !== -1) return demoIndex;
  }
  const saved = onboardingResumeStep();
  if (!saved) return 0;
  const index = steps.indexOf(saved as StepId);
  return index === -1 ? 0 : index;
}

function browserOnboardingDemoStep(): StepId | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const step = new URLSearchParams(window.location.search).get("juneDemoStep");
  return step === "sign-in" ||
    step === "telemetry" ||
    step === "permissions" ||
    step === "dictation-practice"
    ? step
    : null;
}

export function OnboardingFlow({ account, onAccountChanged, onComplete }: Props) {
  const steps = useMemo(() => (isMacLikePlatform() ? MAC_STEPS : NON_MAC_STEPS), []);
  const supportsDictationPractice = steps.includes("dictation-practice");
  const [stepIndex, setStepIndex] = useState(() => {
    const initial = initialStepIndex(steps);
    return account.signedIn && steps[initial] === "sign-in" ? 1 : initial;
  });
  const [shortcutLabel, setShortcutLabel] = useState("fn");

  const stepId = steps[stepIndex];

  // Everything past sign-in needs an account; a resume point past it with a
  // signed-out account (keychain cleared, signed out elsewhere) would strand
  // the user on steps that can't work.
  useEffect(() => {
    if (!account.signedIn && stepId !== "sign-in") {
      setStepIndex(0);
    }
  }, [account.signedIn, stepId]);

  useEffect(() => {
    if (account.signedIn && stepId === "sign-in") {
      setStepIndex(1);
    }
  }, [account.signedIn, stepId]);

  const firstReachableStepIndex = account.signedIn ? 1 : 0;

  useEffect(() => {
    setOnboardingResumeStep(stepId);
  }, [stepId]);

  // Only poll the helper while the user is on the permissions screen.
  const permissionStatuses = usePermissionStatuses(stepId === "permissions");
  // The probe behind this is also what fires the system-audio TCC prompt
  // on a fresh install — deliberately run from the permissions screen, in
  // context, instead of ambushing the user after onboarding.
  const systemAudio = useSystemAudioStatus(stepId === "permissions");

  // Onboarding pitches the bare-fn default, but a version bump replays the
  // wizard for existing users, so it must not clobber a key they customized
  // in Settings. Read first: only the untouched factory default (Ctrl+Opt+D)
  // gets normalized to fn; anything else is reflected as-is. Runs once per
  // wizard run, not per practice-step mount, so a key rebound on the
  // practice screen survives stepping back and forward.
  useEffect(() => {
    if (!supportsDictationPractice) return;
    dictationSettings()
      .then(({ settings }) => {
        const current = settings.pushToTalkShortcut;
        if (current && !isFactoryDefaultShortcut(current)) {
          if (current.label) setShortcutLabel(current.label);
          return undefined;
        }
        return setDictationShortcut("push_to_talk", FN_SHORTCUT).then((saved) => {
          setShortcutLabel(saved?.pushToTalkShortcut?.label ?? FN_SHORTCUT.label);
        });
      })
      .catch(() => undefined);
  }, [supportsDictationPractice]);

  function goNext() {
    if (stepIndex >= steps.length - 1) {
      completeOnboarding();
      return;
    }
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }

  function completeOnboarding() {
    void p3aRecord("onboarding.completed").finally(onComplete);
  }

  function goBack() {
    setStepIndex((index) => {
      return Math.max(index - 1, firstReachableStepIndex);
    });
  }

  return (
    <div className="onboarding-screen">
      <header className="onboarding-topbar">
        {stepIndex > firstReachableStepIndex ? (
          <button
            type="button"
            className="onboarding-back"
            onClick={goBack}
            aria-label="Back"
            title="Back"
          >
            <IconChevronLeftSmall size={18} aria-hidden />
          </button>
        ) : null}
        <nav
          className="onboarding-progress"
          aria-label={`Setup progress: step ${stepIndex + 1} of ${steps.length}`}
        >
          {steps.map((id, index) => (
            <span
              key={id}
              className="onboarding-progress-seg"
              aria-hidden
              data-state={index < stepIndex ? "done" : index === stepIndex ? "current" : "upcoming"}
            />
          ))}
        </nav>
      </header>
      <div className="onboarding-body">
        {stepId === "sign-in" ? (
          <SignInStep account={account} onAccountChanged={onAccountChanged} onContinue={goNext} />
        ) : stepId === "telemetry" ? (
          <TelemetryConsentStep onContinue={goNext} />
        ) : stepId === "permissions" ? (
          <PermissionsStep
            statuses={permissionStatuses}
            systemAudioStatus={systemAudio.status}
            onAllowSystemAudio={systemAudio.probe}
            onContinue={goNext}
          />
        ) : stepId === "dictation-practice" ? (
          <DictationPracticeStep
            shortcutLabel={shortcutLabel}
            onShortcutLabelChange={setShortcutLabel}
            onContinue={completeOnboarding}
          />
        ) : null}
      </div>
    </div>
  );
}
