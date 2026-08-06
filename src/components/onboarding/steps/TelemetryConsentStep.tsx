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
      title="Help improve Clovy"
      subtitle="Optional and off by default. Change it anytime in Settings."
      wide
      className="onboarding-card-privacy"
    >
      <div className="onboarding-privacy-choice settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h2 className="settings-row-title">Share anonymous usage statistics</h2>
              <p className="settings-row-description">
                Anonymous counts of feature usage, like how many dictation sessions happen in a
                week. Never your recordings, notes, or anything you write.{" "}
                <a
                  className="settings-inline-link"
                  href={TELEMETRY_INFO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Learn how it works
                </a>
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={enabled}
                disabled={saving}
                aria-label="Share anonymous usage statistics"
                onCheckedChange={setEnabled}
              />
            </div>
          </div>
        </div>
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
