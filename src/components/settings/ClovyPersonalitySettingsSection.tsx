import { useEffect, useRef, useState } from "react";
import {
  closestOnboardingMood,
  ONBOARDING_MOODS,
  ONBOARDING_MOOD_PERSONALITY_PRESETS,
  saveOnboardingArea,
  saveOnboardingMood,
  type OnboardingArea,
  type OnboardingMood,
} from "../../lib/onboarding";
import { clovyPersona, setClovyPersona } from "../../lib/tauri";
import {
  OnboardingCharacter,
  ONBOARDING_MOOD_PRESENTATION,
} from "../onboarding/OnboardingCharacter";

type SavedSelection = {
  area: OnboardingArea;
  mood: OnboardingMood;
};

export function ClovyPersonalitySettingsSection() {
  const [area, setArea] = useState<OnboardingArea>("work");
  const [mood, setMood] = useState<OnboardingMood>("clearheaded");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const persistedSelection = useRef<SavedSelection | null>(null);
  const queuedSelection = useRef<SavedSelection | null>(null);
  const saveInFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(undefined);
    if (loadAttempt > 0) setStatus(undefined);

    void clovyPersona()
      .then((persona) => {
        if (cancelled) return;
        const loadedMood = closestOnboardingMood(persona);
        persistedSelection.current = { area: persona.area, mood: loadedMood };
        setArea(persona.area);
        setMood(loadedMood);
        setLoaded(true);
      })
      .catch((cause) => {
        if (!cancelled) setError(messageFromError(cause, "Unable to load Clovy's personality."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  function updateMood(nextMood: OnboardingMood) {
    setMood(nextMood);
    setStatus("Saving...");
    setError(undefined);
    queuedSelection.current = { area, mood: nextMood };
    void flushQueuedSelection();
  }

  async function flushQueuedSelection() {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    if (mounted.current) setSaving(true);

    while (queuedSelection.current) {
      const selection = queuedSelection.current;
      queuedSelection.current = null;

      try {
        const persona = await setClovyPersona({
          area: selection.area,
          ...ONBOARDING_MOOD_PERSONALITY_PRESETS[selection.mood],
        });
        const confirmedMood = closestOnboardingMood(persona);
        persistedSelection.current = { area: persona.area, mood: confirmedMood };
        saveOnboardingArea(persona.area);
        saveOnboardingMood(confirmedMood);

        if (mounted.current && queuedSelection.current === null) {
          setArea(persona.area);
          setMood(confirmedMood);
          setStatus("Saved");
        }
      } catch (cause) {
        if (mounted.current && queuedSelection.current === null) {
          const persisted = persistedSelection.current;
          if (persisted) {
            setArea(persisted.area);
            setMood(persisted.mood);
          }
          setError(messageFromError(cause, "Unable to save Clovy's personality."));
          setStatus(undefined);
        }
      }
    }

    saveInFlight.current = false;
    if (mounted.current) setSaving(false);
  }

  return (
    <>
      <h2 id="agent-personality-heading" className="settings-group-heading">
        Personality
      </h2>
      <p className="settings-group-description">
        Choose the voice Clovy uses in Home and new agent sessions.
      </p>
      {loading ? (
        <div className="settings-card settings-personality-loading" aria-busy="true">
          <span className="settings-personality-skeleton settings-personality-skeleton-short" />
          <span className="settings-personality-skeleton" />
          <span className="visually-hidden">Loading Clovy's personality</span>
        </div>
      ) : !loaded ? (
        <div className="settings-card settings-personality-load-error">
          <p className="settings-row-error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="primary-action"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="settings-card settings-personality-card">
          <fieldset className="settings-personality-grid">
            <legend className="visually-hidden">Choose Clovy's personality</legend>
            {ONBOARDING_MOODS.map((optionMood) => {
              const selected = optionMood === mood;
              const presentation = ONBOARDING_MOOD_PRESENTATION[optionMood];
              return (
                <label
                  key={optionMood}
                  className="settings-card settings-personality-option"
                  data-selected={selected ? "true" : undefined}
                >
                  <input
                    className="visually-hidden"
                    type="radio"
                    name="clovy-personality"
                    value={optionMood}
                    checked={selected}
                    onChange={() => updateMood(optionMood)}
                  />
                  <OnboardingCharacter mood={optionMood} />
                  <span className="settings-personality-option-copy">
                    <span className="settings-personality-option-name">{presentation.label}</span>
                    <span className="settings-personality-option-description">
                      {presentation.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div
            className="settings-personality-preview"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="settings-personality-preview-speaker">Clovy</span>
            <p className="settings-personality-preview-greeting shimmer">
              {ONBOARDING_MOOD_PRESENTATION[mood].greeting}
            </p>
          </div>

          <div className="settings-personality-actions">
            <div className="settings-personality-feedback">
              <p>Applies to future Home replies and the next agent run.</p>
              {error ? (
                <p className="settings-row-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            {status || saving ? (
              <p className="settings-personality-status" role="status" aria-live="polite">
                {saving ? "Saving..." : status}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}
