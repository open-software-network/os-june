import { useEffect, useState } from "react";
import { dispatchP3aSettingsChanged, TELEMETRY_INFO_URL } from "../../lib/p3a";
import { p3aSettings, setP3aEnabled, type P3aSettingsDto } from "../../lib/tauri";
import { Switch } from "../ui/Switch";

const DEFAULT_P3A_SETTINGS: P3aSettingsDto = {
  enabled: false,
  consentVersion: 1,
  consentedAtWeek: null,
};

export function PrivacySettingsSection() {
  const [settings, setSettings] = useState<P3aSettingsDto>(DEFAULT_P3A_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    p3aSettings()
      .then((response) => {
        if (!cancelled) setSettings(response.settings);
      })
      .catch(() => {
        if (!cancelled) setStatus("Could not load privacy settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleUsageStatistics(enabled: boolean) {
    setSaving(true);
    setStatus(undefined);
    try {
      const response = await setP3aEnabled(enabled);
      setSettings(response.settings);
      dispatchP3aSettingsChanged(response.settings);
      setStatus(
        enabled
          ? "Anonymous usage statistics are on for this device."
          : "Anonymous usage statistics are off. Usage data stored on this device was deleted.",
      );
    } catch {
      setStatus("Could not update usage statistics. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-group" aria-labelledby="general-privacy-heading">
      <h2 id="general-privacy-heading" className="settings-group-heading">
        Privacy
      </h2>
      <p className="settings-group-description">
        Choose whether June shares anonymous usage statistics with Open Software. Off by default.
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Share anonymous usage statistics</h3>
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
                checked={settings.enabled}
                disabled={saving}
                aria-label="Share anonymous usage statistics"
                onCheckedChange={(enabled) => void toggleUsageStatistics(enabled)}
              />
            </div>
          </div>
        </div>
      </div>
      {status ? (
        <p className="settings-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
