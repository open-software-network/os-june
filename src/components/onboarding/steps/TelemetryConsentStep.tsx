import { useState } from "react";
import { dispatchP3aSettingsChanged, TELEMETRY_INFO_URL } from "../../../lib/p3a";
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
      title="Help improve June"
      subtitle="Optional and off by default. Change it anytime in Settings."
      wide
      className="onboarding-card-privacy"
    >
      <div className="onboarding-privacy-choice">
        <div className="onboarding-privacy-copy">
          <h2>Share anonymous usage statistics</h2>
          <p>
            Anonymous counts of feature usage, like how many dictation sessions happen in a week.
            Never your recordings, notes, or anything you write, and nothing that can identify you.
          </p>
          <a href={TELEMETRY_INFO_URL} target="_blank" rel="noreferrer">
            Learn how it works
          </a>
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
