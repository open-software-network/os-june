import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { useEffect, useState } from "react";
import {
  onboardingResumeStep,
  setOnboardingResumeStep,
} from "../../lib/onboarding";
import { dictationSettings, setDictationShortcut } from "../../lib/tauri";
import type { AccountStatus, DictationShortcutSetting } from "../../lib/tauri";
import { isSubscriptionActive } from "../../lib/trial-checkout";
import { PermissionsStep } from "./steps/PermissionSteps";
import { DictationPracticeStep } from "./steps/PracticeStep";
import { SignInStep } from "./steps/SignInStep";
import { TrialStep } from "./steps/TrialStep";
import {
  usePermissionStatuses,
  useSystemAudioStatus,
} from "./use-permission-status";

type StepId = "sign-in" | "permissions" | "trial" | "dictation-practice";

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

const STEPS: StepId[] = [
  "sign-in",
  "permissions",
  "trial",
  "dictation-practice",
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
  const [stepIndex, setStepIndex] = useState(() => {
    const initial = initialStepIndex();
    return account.signedIn && STEPS[initial] === "sign-in" ? 1 : initial;
  });
  const [shortcutLabel, setShortcutLabel] = useState("fn");

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
    dictationSettings()
      .then(({ settings }) => {
        const current = settings.pushToTalkShortcut;
        if (current && !isFactoryDefaultShortcut(current)) {
          if (current.label) setShortcutLabel(current.label);
          return undefined;
        }
        return setDictationShortcut("push_to_talk", FN_SHORTCUT).then(
          (saved) => {
            setShortcutLabel(
              saved?.pushToTalkShortcut?.label ?? FN_SHORTCUT.label,
            );
          },
        );
      })
      .catch(() => undefined);
  }, []);

  function goNext() {
    setStepIndex((index) => Math.min(index + 1, STEPS.length - 1));
  }

  function goBack() {
    setStepIndex((index) => {
      let next = Math.max(index - 1, firstReachableStepIndex);
      // The trial step auto-skips forward for subscribed users; stepping
      // back onto it would just bounce, so hop over it instead.
      if (STEPS[next] === "trial" && isSubscriptionActive(account)) {
        next = Math.max(next - 1, firstReachableStepIndex);
      }
      return next;
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
      </header>
      <div className="onboarding-body">
        {stepId === "sign-in" ? (
          <SignInStep
            account={account}
            onAccountChanged={onAccountChanged}
            onContinue={goNext}
          />
        ) : stepId === "permissions" ? (
          <PermissionsStep
            statuses={permissionStatuses}
            systemAudioStatus={systemAudio.status}
            onAllowSystemAudio={systemAudio.probe}
            onContinue={goNext}
          />
        ) : stepId === "trial" ? (
          <TrialStep
            account={account}
            onRefresh={onRefreshAccount}
            onContinue={goNext}
          />
        ) : stepId === "dictation-practice" ? (
          <DictationPracticeStep
            shortcutLabel={shortcutLabel}
            onShortcutLabelChange={setShortcutLabel}
            onContinue={onComplete}
          />
        ) : null}
      </div>
    </div>
  );
}
