import { useEffect, useState } from "react";
import { juneCharacter, setJuneCharacter } from "../../../lib/tauri";
import { StepActions, StepCard } from "../StepChrome";

/** Mirrors JUNE_CHARACTER_MAX_CHARS on the Rust side. */
const CHARACTER_MAX_LENGTH = 4000;

/**
 * Lets a new user rewrite June's character (personality and tone) during
 * setup, prefilled with the effective text so keeping the default is one
 * click. Saving writes CHARACTER.md through the backend; the rest of June's
 * instructions (identity, privacy, tools) are not editable here. Skipping
 * or continuing unchanged writes nothing.
 */
export function CharacterStep({ onContinue }: { onContinue: () => void }) {
  const [draft, setDraft] = useState("");
  const [loadedCharacter, setLoadedCharacter] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    juneCharacter()
      .then((status) => {
        if (cancelled) return;
        setLoadedCharacter(status.character);
        // Prefill only a pristine draft: never clobber text the user
        // already typed while the load was in flight.
        setDraft((current) => (current === "" ? status.character : current));
      })
      .catch(() => {
        // Leave the textarea empty; continue and skip still work, and any
        // typed text is still offered to the backend on continue.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function continueWithCharacter() {
    const trimmed = draft.trim();
    const baseline = loadedCharacter?.trim() ?? "";
    if (trimmed === baseline) {
      onContinue();
      return;
    }
    setSaving(true);
    try {
      await setJuneCharacter(trimmed);
      onContinue();
    } catch {
      setError("Could not save the character. Try again, or skip and set it later in Settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepCard
      title="Give June a personality"
      subtitle="This is how June talks to you. Keep it, tweak it, or rewrite it. You can change it anytime in Settings."
      wide
    >
      <textarea
        className="onboarding-character-input"
        value={draft}
        rows={7}
        maxLength={CHARACTER_MAX_LENGTH}
        aria-label="June's character"
        placeholder="Describe how June should talk and behave."
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      {error ? (
        <p className="onboarding-character-error" role="alert">
          {error}
        </p>
      ) : null}
      <StepActions
        onContinue={() => void continueWithCharacter()}
        continueDisabled={saving}
        onSkip={onContinue}
      />
    </StepCard>
  );
}
