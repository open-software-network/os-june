import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useId, useState } from "react";
import {
  onboardingCustomUseCase,
  onboardingUseCases,
  saveOnboardingCustomUseCase,
  saveOnboardingUseCases,
  type OnboardingUseCase,
} from "../../../lib/onboarding";
import { p3aRecord } from "../../../lib/tauri";
import { StepActions, StepCard } from "../StepChrome";

const USE_CASE_OPTIONS: ReadonlyArray<{
  id: OnboardingUseCase;
  label: string;
  p3aQuestionId: string;
}> = [
  { id: "work", label: "Work", p3aQuestionId: "onboarding.use-case.work" },
  { id: "personal", label: "Personal", p3aQuestionId: "onboarding.use-case.personal" },
  { id: "school", label: "School", p3aQuestionId: "onboarding.use-case.school" },
  { id: "creative", label: "Creative projects", p3aQuestionId: "onboarding.use-case.creative" },
  { id: "coding", label: "Coding", p3aQuestionId: "onboarding.use-case.coding" },
  { id: "meetings", label: "Meetings", p3aQuestionId: "onboarding.use-case.meetings" },
  { id: "other", label: "Other", p3aQuestionId: "onboarding.use-case.other" },
  { id: "not-sure", label: "Not sure yet", p3aQuestionId: "onboarding.use-case.not-sure" },
];

export function UsageIntentStep({ onContinue }: { onContinue: () => void }) {
  const otherInputId = useId();
  const [selected, setSelected] = useState<ReadonlySet<OnboardingUseCase>>(
    () => new Set(onboardingUseCases()),
  );
  const [customUseCase, setCustomUseCase] = useState(() => onboardingCustomUseCase());
  const otherSelected = selected.has("other");
  const continueDisabled = selected.size === 0 || (otherSelected && customUseCase.trim() === "");

  function toggle(useCase: OnboardingUseCase) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(useCase)) next.delete(useCase);
      else next.add(useCase);
      return next;
    });
  }

  function continueWithSelection() {
    const selectedOptions = USE_CASE_OPTIONS.filter(({ id }) => selected.has(id));
    saveOnboardingUseCases(selectedOptions.map(({ id }) => id));
    saveOnboardingCustomUseCase(otherSelected ? customUseCase : "");
    void Promise.allSettled(selectedOptions.map(({ p3aQuestionId }) => p3aRecord(p3aQuestionId)));
    onContinue();
  }

  return (
    <StepCard title="What are you interested in using June for?" subtitle="Pick all that fit." wide>
      <fieldset className="onboarding-intent-grid" aria-label="June interests">
        {USE_CASE_OPTIONS.map(({ id, label }) => {
          const active = selected.has(id);
          return (
            <button
              key={id}
              type="button"
              className="onboarding-intent-option"
              aria-pressed={active}
              onClick={() => toggle(id)}
            >
              <span className="onboarding-intent-check" aria-hidden>
                {active ? <IconCheckmark1Small size={15} /> : null}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </fieldset>
      {otherSelected ? (
        <label className="onboarding-intent-other" htmlFor={otherInputId}>
          <span>What else?</span>
          <input
            id={otherInputId}
            type="text"
            value={customUseCase}
            onChange={(event) => setCustomUseCase(event.currentTarget.value)}
            placeholder="Type your own use case"
            maxLength={120}
          />
        </label>
      ) : null}
      <StepActions onContinue={continueWithSelection} continueDisabled={continueDisabled} />
    </StepCard>
  );
}
