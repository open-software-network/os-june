import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconBrainSideview } from "central-icons/IconBrainSideview";
import { IconDices } from "central-icons/IconDices";
import { IconHomeRoundDoor } from "central-icons/IconHomeRoundDoor";
import { IconSuitcaseWork } from "central-icons/IconSuitcaseWork";
import { useState } from "react";
import { onboardingArea, saveOnboardingArea, type OnboardingArea } from "../../../lib/onboarding";
import { JuneOnboardingArt } from "../JuneOnboardingArt";
import { StepActions, StepCard } from "../StepChrome";

const AREA_OPTIONS: ReadonlyArray<{
  id: OnboardingArea;
  title: string;
  examples: string;
  icon: typeof IconSuitcaseWork;
}> = [
  {
    id: "work",
    title: "Staying on top of work",
    examples: "Meeting notes, dictation, follow-ups, files, and loose ends",
    icon: IconSuitcaseWork,
  },
  {
    id: "personal",
    title: "Managing my personal life",
    examples: "Voice notes, journaling, plans, decisions, and paperwork",
    icon: IconHomeRoundDoor,
  },
  {
    id: "thinking",
    title: "Thinking, writing, and reflecting",
    examples: "Brain-dumps, clearer drafts, decisions, perspective, and hard problems",
    icon: IconBrainSideview,
  },
  {
    id: "play",
    title: "Having fun and creating",
    examples: "Characters, role-play, stories, games, and imaginary worlds",
    icon: IconDices,
  },
];

export function AreaStep({ onContinue }: { onContinue: (area: OnboardingArea) => void }) {
  const [selected, setSelected] = useState<OnboardingArea | null>(() => onboardingArea());

  function continueWithSelection() {
    if (!selected) return;
    saveOnboardingArea(selected);
    onContinue(selected);
  }

  return (
    <StepCard
      title="Where could I help most?"
      subtitle="Pick the part of life you'd most like me to make easier."
      illustration={<JuneOnboardingArt scene="areas" size="medium" />}
      wide
      className="onboarding-card-areas"
    >
      <fieldset className="onboarding-intent-grid" aria-label="Where June can help most">
        {AREA_OPTIONS.map(({ id, title, examples, icon: Icon }) => {
          const active = selected === id;
          return (
            <button
              key={id}
              type="button"
              className="onboarding-intent-option"
              aria-pressed={active}
              onClick={() => setSelected(id)}
            >
              <span className="onboarding-intent-icon" aria-hidden>
                <Icon size={17} />
              </span>
              <span className="onboarding-intent-copy">
                <span className="onboarding-intent-title">{title}</span>
                <span className="onboarding-intent-examples">{examples}</span>
              </span>
              <span className="onboarding-intent-check" aria-hidden>
                {active ? <IconCheckmark2Small size={14} /> : null}
              </span>
            </button>
          );
        })}
      </fieldset>
      <StepActions onContinue={continueWithSelection} continueDisabled={!selected} />
    </StepCard>
  );
}
