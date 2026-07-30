import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { useState } from "react";
import {
  ONBOARDING_MOOD_PERSONALITY_PRESETS,
  ONBOARDING_MOODS,
  ONBOARDING_AREA_MOOD_PRESETS,
  onboardingMood,
  saveOnboardingMood,
  type OnboardingArea,
  type OnboardingMood,
} from "../../../lib/onboarding";
import { setJunePersona } from "../../../lib/tauri";
import { OnboardingCharacter, ONBOARDING_MOOD_PRESENTATION } from "../OnboardingCharacter";
import { StepActions, StepCard } from "../StepChrome";

export function MoodStep({
  area,
  onContinue,
}: {
  area: OnboardingArea;
  onContinue: (mood: OnboardingMood) => void;
}) {
  const [selected, setSelected] = useState<OnboardingMood>(() =>
    onboardingMood(ONBOARDING_AREA_MOOD_PRESETS[area]),
  );
  const [focusVisible, setFocusVisible] = useState<OnboardingMood | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedPresentation = ONBOARDING_MOOD_PRESENTATION[selected];

  async function continueWithMood() {
    setSaving(true);
    setSaveError(null);
    try {
      await setJunePersona({ area, ...ONBOARDING_MOOD_PERSONALITY_PRESETS[selected] });
      saveOnboardingMood(selected);
      onContinue(selected);
    } catch {
      setSaveError("I couldn't save this yet. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepCard
      title="Choose my personality"
      subtitle="Pick the mood for our first conversation."
      wide
      className="onboarding-card-moods"
    >
      <fieldset className="onboarding-mood-grid">
        <legend className="visually-hidden">Choose June's greeting mood</legend>
        {ONBOARDING_MOODS.map((mood) => {
          const active = mood === selected;
          const { label, description } = ONBOARDING_MOOD_PRESENTATION[mood];
          return (
            <label
              key={mood}
              className="onboarding-mood-option"
              data-mood={mood}
              data-selected={active ? "true" : undefined}
              data-focus-visible={focusVisible === mood ? "true" : undefined}
            >
              <input
                className="visually-hidden"
                type="radio"
                name="onboarding-mood"
                value={mood}
                checked={active}
                onChange={() => {
                  setSelected(mood);
                  setSaveError(null);
                }}
                onFocus={(event) => {
                  setFocusVisible(event.currentTarget.matches(":focus-visible") ? mood : null);
                }}
                onBlur={() => setFocusVisible(null)}
              />
              <span className="onboarding-mood-check" aria-hidden data-visible={active}>
                <IconCheckmark2Small size={14} />
              </span>
              <OnboardingCharacter mood={mood} />
              <span className="onboarding-mood-copy">
                <span className="onboarding-mood-name">{label}</span>
                <span className="onboarding-mood-description">{description}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="onboarding-mood-preview">
        <div className="onboarding-mood-preview-stack" aria-hidden="true">
          {ONBOARDING_MOODS.map((mood) => {
            const presentation = ONBOARDING_MOOD_PRESENTATION[mood];
            return (
              <div
                key={mood}
                className="onboarding-mood-preview-content"
                data-active={mood === selected}
              >
                <OnboardingCharacter mood={mood} className="onboarding-mood-preview-character" />
                <div className="onboarding-mood-preview-copy">
                  <span className="onboarding-mood-preview-speaker">June</span>
                  <p className="onboarding-mood-preview-greeting shimmer">
                    {presentation.greeting}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {selectedPresentation.label} tone. {selectedPresentation.greeting}
        </p>
      </div>
      {saveError ? (
        <p className="onboarding-mood-save-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <StepActions
        continueLabel={saving ? "Saving..." : "Continue"}
        continueDisabled={saving}
        onContinue={() => void continueWithMood()}
      />
    </StepCard>
  );
}
