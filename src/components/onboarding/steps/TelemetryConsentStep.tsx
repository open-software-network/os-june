import { useState } from "react";
import type { OnboardingArea } from "../../../lib/onboarding";
import { dispatchP3aSettingsChanged, TELEMETRY_INFO_URL } from "../../../lib/p3a";
import { p3aRecord, setP3aEnabled } from "../../../lib/tauri";
import { Switch } from "../../ui/Switch";
import { JuneOnboardingArt } from "../JuneOnboardingArt";
import { StepActions, StepCard } from "../StepChrome";

export function TelemetryConsentStep({
  area,
  onContinue,
}: {
  area: OnboardingArea;
  onContinue: () => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function continueWithChoice() {
    setSaving(true);
    setError(undefined);
    try {
      const response = await setP3aEnabled(enabled);
      dispatchP3aSettingsChanged(response.settings);
      if (enabled) void p3aRecord(`onboarding.area.${area}`);
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
      subtitle="This is optional and off by default. You can change it anytime."
      illustration={<JuneOnboardingArt scene="telemetry" size="medium" />}
      wide
      className="onboarding-card-privacy"
    >
      <div className="onboarding-privacy-choice">
        <div className="onboarding-privacy-copy">
          <h2>Share anonymous usage statistics</h2>
          <p>
            I'll only see anonymous counts, like how often dictation gets used. Never your prompts,
            recordings, notes, or anything you write.
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
