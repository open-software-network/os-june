import { useState } from "react";
import { dispatchP3aSettingsChanged } from "../../../lib/p3a";
import { setP3aEnabled } from "../../../lib/tauri";
import { Switch } from "../../ui/Switch";
import { StepActions, StepCard } from "../StepChrome";

export function TelemetryConsentStep({ onContinue }: { onContinue: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function continueWithChoice() {
    setSaving(true);
    setError(undefined);
    try {
      const response = await setP3aEnabled(enabled);
      dispatchP3aSettingsChanged(response.settings);
      onContinue();
    } catch {
      setError("Could not save this choice. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepCard
      title="Share anonymous usage statistics?"
      subtitle="This is optional and off by default."
      wide
      className="onboarding-card-privacy"
    >
      <div className="onboarding-privacy-choice">
        <div className="onboarding-privacy-copy">
          <h2>Share anonymous usage statistics</h2>
          <p>
            Never your recordings, notes, or written content. Only anonymous counts that help us
            understand feature usage.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={saving}
          aria-label="Share anonymous usage statistics"
          onCheckedChange={setEnabled}
        />
      </div>
      {error ? <p className="welcome-status">{error}</p> : null}
      <StepActions
        continueLabel={saving ? "Saving" : "Continue"}
        continueDisabled={saving}
        onContinue={() => void continueWithChoice()}
      />
    </StepCard>
  );
}
