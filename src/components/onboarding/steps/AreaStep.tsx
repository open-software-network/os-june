import { IconBrainSideview } from "central-icons/IconBrainSideview";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconDices } from "central-icons/IconDices";
import { IconHomeRoundDoor } from "central-icons/IconHomeRoundDoor";
import { IconSuitcaseWork } from "central-icons/IconSuitcaseWork";
import { useState } from "react";
import {
  ONBOARDING_AREAS,
  ONBOARDING_AREA_MOOD_PRESETS,
  onboardingArea,
  saveOnboardingArea,
  type OnboardingArea,
} from "../../../lib/onboarding";
import { StepActions, StepCard } from "../StepChrome";

const AREA_PRESENTATION: Record<
  OnboardingArea,
  {
    label: string;
    description: string;
    icon: typeof IconSuitcaseWork;
  }
> = {
  work: {
    label: "Work",
    description: "Meetings, follow-ups, and focused work",
    icon: IconSuitcaseWork,
  },
  personal: {
    label: "Personal",
    description: "Plans, journaling, and everyday life",
    icon: IconHomeRoundDoor,
  },
  thinking: {
    label: "Thinking",
    description: "Ideas, writing, and clearer decisions",
    icon: IconBrainSideview,
  },
  play: {
    label: "Play",
    description: "Stories, characters, and creative projects",
    icon: IconDices,
  },
};

export function AreaStep({ onContinue }: { onContinue: (area: OnboardingArea) => void }) {
  const [selected, setSelected] = useState<OnboardingArea | null>(() => onboardingArea());
  const [focusVisible, setFocusVisible] = useState<OnboardingArea | null>(null);

  function continueWithArea() {
    if (!selected) return;
    saveOnboardingArea(selected);
    onContinue(selected);
  }

  return (
    <StepCard
      title="Where could I help most?"
      subtitle="Pick the part of life you'd most like me to make easier."
      wide
      className="onboarding-card-moods onboarding-card-areas"
    >
      <fieldset className="onboarding-mood-grid onboarding-area-grid">
        <legend className="visually-hidden">Choose where Clovy should help first</legend>
        {ONBOARDING_AREAS.map((area) => {
          const active = area === selected;
          const { label, description, icon: Icon } = AREA_PRESENTATION[area];
          return (
            <label
              key={area}
              className="onboarding-mood-option onboarding-area-option"
              data-area={area}
              data-mood={ONBOARDING_AREA_MOOD_PRESETS[area]}
              data-selected={active ? "true" : undefined}
              data-focus-visible={focusVisible === area ? "true" : undefined}
            >
              <input
                className="visually-hidden"
                type="radio"
                name="onboarding-area"
                value={area}
                checked={active}
                onChange={() => setSelected(area)}
                onFocus={(event) => {
                  setFocusVisible(event.currentTarget.matches(":focus-visible") ? area : null);
                }}
                onBlur={() => setFocusVisible(null)}
              />
              <span className="onboarding-mood-check" aria-hidden data-visible={active}>
                <IconCheckmark2Small size={14} />
              </span>
              <span className="onboarding-area-icon" aria-hidden>
                <Icon size={20} />
              </span>
              <span className="onboarding-mood-copy">
                <span className="onboarding-mood-name">{label}</span>
                <span className="onboarding-mood-description">{description}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <StepActions onContinue={continueWithArea} continueDisabled={!selected} />
    </StepCard>
  );
}
