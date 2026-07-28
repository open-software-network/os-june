import { IconCheckmark2Medium } from "central-icons/IconCheckmark2Medium";
import { useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ONBOARDING_PERSONALITY_PRESETS,
  onboardingPersonality,
  saveOnboardingPersonality,
  type OnboardingArea,
  type OnboardingPersonality,
} from "../../../lib/onboarding";
import {
  PERSONALITY_STEP_SUBTITLES,
  personalityPreviewMessage,
  personalityStylesForArea,
} from "../../../lib/onboarding-personality";
import { setJunePersona } from "../../../lib/tauri";
import { JuneOnboardingArt } from "../JuneOnboardingArt";
import { StepActions, StepCard } from "../StepChrome";

function personalitiesMatch(left: OnboardingPersonality, right: OnboardingPersonality) {
  return (
    left.voice === right.voice &&
    left.detail === right.detail &&
    left.initiative === right.initiative &&
    left.humor === right.humor
  );
}

export function PersonalityStep({
  area,
  onContinue,
}: {
  area: OnboardingArea;
  onContinue: () => void;
}) {
  const [personality, setPersonality] = useState<OnboardingPersonality>(() =>
    onboardingPersonality(area),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();
  const message = useMemo(() => personalityPreviewMessage(area, personality), [area, personality]);
  const [streamedMessage, setStreamedMessage] = useState(message);
  const [announcedMessage, setAnnouncedMessage] = useState(message);
  const [streaming, setStreaming] = useState(false);
  const previousMessage = useRef(message);
  const streamTimer = useRef<number>();
  const streamGeneration = useRef(0);
  const personalityStyles = useMemo(() => personalityStylesForArea(area), [area]);
  const selectedStyle = personalityStyles.find((style) =>
    personalitiesMatch(personality, ONBOARDING_PERSONALITY_PRESETS[style.id]),
  );

  useEffect(() => {
    if (previousMessage.current === message) return;
    previousMessage.current = message;
    streamGeneration.current += 1;
    const generation = streamGeneration.current;

    if (streamTimer.current !== undefined) window.clearTimeout(streamTimer.current);

    if (reduceMotion) {
      setStreamedMessage(message);
      setAnnouncedMessage(message);
      setStreaming(false);
      return;
    }

    setStreamedMessage("");
    setAnnouncedMessage("");
    setStreaming(true);

    let visibleCharacters = 0;
    const chunkSize = Math.max(2, Math.ceil(message.length / 44));

    function revealNextChunk() {
      if (streamGeneration.current !== generation) return;
      visibleCharacters = Math.min(message.length, visibleCharacters + chunkSize);
      setStreamedMessage(message.slice(0, visibleCharacters));

      if (visibleCharacters < message.length) {
        streamTimer.current = window.setTimeout(revealNextChunk, 16);
        return;
      }

      streamTimer.current = undefined;
      setStreaming(false);
      setAnnouncedMessage(message);
    }

    streamTimer.current = window.setTimeout(revealNextChunk, 48);

    return () => {
      if (streamTimer.current !== undefined) {
        window.clearTimeout(streamTimer.current);
        streamTimer.current = undefined;
      }
    };
  }, [message, reduceMotion]);

  function selectStyle(style: OnboardingArea) {
    const next = { ...ONBOARDING_PERSONALITY_PRESETS[style] };
    setPersonality(next);
    saveOnboardingPersonality(next);
    setSaveError(null);
  }

  async function continueWithPersonality() {
    saveOnboardingPersonality(personality);
    setSaving(true);
    setSaveError(null);
    try {
      await setJunePersona({ area, ...personality });
      onContinue();
    } catch {
      setSaveError("I couldn't save this yet. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepCard
      title="How should I show up?"
      subtitle={PERSONALITY_STEP_SUBTITLES[area]}
      wide
      className="onboarding-card-personality"
    >
      <fieldset className="onboarding-personality-choices">
        <legend className="visually-hidden">Choose June's personality</legend>
        {personalityStyles.map(({ id, name, description }) => {
          const selected = selectedStyle?.id === id;
          return (
            <label
              key={id}
              className="onboarding-personality-choice"
              data-selected={selected || undefined}
            >
              <input
                type="radio"
                name="june-personality"
                value={id}
                checked={selected}
                onChange={() => selectStyle(id)}
              />
              <JuneOnboardingArt scene={id} size="small" animated={selected} />
              <span className="onboarding-personality-choice-copy">
                <span>{name}</span>
                <span>{description}</span>
              </span>
              <span
                className="onboarding-personality-choice-check"
                aria-hidden="true"
                data-visible={selected || undefined}
              >
                <IconCheckmark2Medium size={16} />
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="onboarding-personality-preview">
        <span className="onboarding-personality-preview-label">A preview from June</span>
        <div className="agent-timeline onboarding-personality-thread" data-home="true">
          <article
            className="agent-user-turn onboarding-personality-message"
            data-user-run-end="true"
            data-streaming={streaming ? "true" : undefined}
            aria-label="Example message from June"
            aria-busy={streaming}
          >
            <div
              className="agent-user-turn-body onboarding-personality-message-body"
              data-reserve-message={message}
            >
              <p className="onboarding-personality-message-copy" aria-hidden="true">
                {streamedMessage}
                {streaming ? (
                  <span className="onboarding-personality-stream-caret" aria-hidden="true" />
                ) : null}
              </p>
              <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
                {streaming ? "June is typing" : announcedMessage}
              </span>
            </div>
          </article>
        </div>
      </div>

      {saveError ? (
        <p className="onboarding-personality-save-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <StepActions
        continueLabel={saving ? "Saving..." : "Meet June"}
        continueDisabled={saving}
        onContinue={() => void continueWithPersonality()}
      />
    </StepCard>
  );
}
