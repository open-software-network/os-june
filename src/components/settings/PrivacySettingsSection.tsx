import { useEffect, useState } from "react";
import { dispatchP3aSettingsChanged, TELEMETRY_INFO_URL } from "../../lib/p3a";
import { p3aSettings, setP3aEnabled, type P3aSettingsDto } from "../../lib/tauri";
import { Switch } from "../ui/Switch";
import { SettingsPageHeader } from "./AppSettings";

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
          : "Anonymous usage statistics are off and local counters were deleted.",
      );
    } catch {
      setStatus("Could not update usage statistics. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SettingsPageHeader
        title="Privacy"
        blurb="Control optional data sharing and review exactly what June can report."
      />
      <section className="settings-group" aria-labelledby="privacy-usage-heading">
        <h2 id="privacy-usage-heading" className="settings-group-heading">
          Anonymous usage statistics
        </h2>
        <p className="settings-group-description">
          Opt in to coarse product counts that help prioritize June work.
        </p>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Share anonymous usage statistics</h3>
                <p className="settings-row-description">
                  Never your recordings, notes, or written content. Only anonymous counts that help
                  us understand feature usage.
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

            <div className="settings-row settings-row-meta">
              <div className="settings-row-info">
                <h3 className="settings-row-title settings-meta-label">Consent week</h3>
              </div>
              <div className="settings-row-control">
                <span className="settings-meta-value">
                  {settings.enabled && settings.consentedAtWeek
                    ? settings.consentedAtWeek
                    : "Not enabled"}
                </span>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">How usage statistics work</h3>
                <p className="settings-row-description">
                  Read the policy, current local-only behavior, and public question catalog.
                </p>
              </div>
              <div className="settings-row-control">
                <a
                  className="btn btn-secondary"
                  href={TELEMETRY_INFO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Learn how it works
                </a>
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
    </>
  );
}
